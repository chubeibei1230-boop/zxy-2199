const { stores, newId } = require('../models');
const { CONFIG_DEFAULTS, WAVE_STATUS, DISCREPANCY_LEVEL } = require('../models/constants');

const ALERT_TYPES = {
  DUPLICATE_WAVE: 'DUPLICATE_WAVE',
  PATH_DETOUR_EXCESS: 'PATH_DETOUR_EXCESS',
  LOCATION_DISCREPANCY_CLUSTER: 'LOCATION_DISCREPANCY_CLUSTER',
  REVIEW_TIMEOUT: 'REVIEW_TIMEOUT',
  STOCKOUT_NO_EXPLANATION: 'STOCKOUT_NO_EXPLANATION',
  PACKING_CONFIRM_MISS: 'PACKING_CONFIRM_MISS'
};

function getConfig(key) {
  const store = stores.configs();
  const record = store.findOne({ key });
  return record ? record.value : CONFIG_DEFAULTS[key] !== undefined ? CONFIG_DEFAULTS[key] : null;
}

function setConfig(key, value) {
  const store = stores.configs();
  const existing = store.findOne({ key });
  if (existing) {
    return store.update(existing.id, { value, updatedAt: new Date().toISOString() });
  }
  return store.create({ id: newId(), key, value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

function createAlert(type, level, message, details = {}) {
  const alertsStore = stores.alerts();
  const existing = alertsStore.findOne({
    type,
    resolved: false,
    'details.refKey': details.refKey
  });
  if (existing) {
    return alertsStore.update(existing.id, {
      message,
      details,
      level,
      lastTriggeredAt: new Date().toISOString(),
      triggerCount: (existing.triggerCount || 1) + 1
    });
  }
  return alertsStore.create({
    id: newId(),
    type,
    level,
    message,
    details,
    resolved: false,
    triggerCount: 1,
    lastTriggeredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function checkDuplicateWaveStart(waveId) {
  const wavesStore = stores.waves();
  const wave = wavesStore.findById(waveId);
  if (!wave) return null;
  if (wave.status === WAVE_STATUS.PICKING || wave.status === WAVE_STATUS.TO_CHECK) {
    return createAlert(
      ALERT_TYPES.DUPLICATE_WAVE,
      DISCREPANCY_LEVEL.HIGH,
      `波次 [${wave.waveNo}] 已处于"${wave.status}"状态，禁止重复开启`,
      { refKey: waveId, waveId, waveNo: wave.waveNo, currentStatus: wave.status }
    );
  }
  return null;
}

function checkPathDetour(waveId, pickerId) {
  const threshold = getConfig('PATH_DEVIATION_THRESHOLD') || CONFIG_DEFAULTS.PATH_DEVIATION_THRESHOLD;
  const recordsStore = stores.pickingRecords();
  const deviatedRecords = recordsStore.find({
    waveId,
    pickerId,
    pathDeviation: true
  });
  if (deviatedRecords.length >= threshold) {
    return createAlert(
      ALERT_TYPES.PATH_DETOUR_EXCESS,
      DISCREPANCY_LEVEL.MEDIUM,
      `拣货员 [${pickerId}] 在波次中路径偏离次数达到 ${deviatedRecords.length} 次，超过阈值 ${threshold}`,
      { refKey: `${waveId}-${pickerId}`, waveId, pickerId, deviatedCount: deviatedRecords.length, threshold }
    );
  }
  return null;
}

function checkLocationDiscrepancyCluster(locationId) {
  const threshold = getConfig('LOCATION_DISCREPANCY_THRESHOLD') || CONFIG_DEFAULTS.LOCATION_DISCREPANCY_THRESHOLD;
  const checkRecordsStore = stores.checkRecords();
  const discrepancies = checkRecordsStore.find({
    locationId,
    hasDiscrepancy: true
  });
  const locationStore = stores.locations();
  const location = locationStore.findById(locationId);
  if (discrepancies.length >= threshold) {
    return createAlert(
      ALERT_TYPES.LOCATION_DISCREPANCY_CLUSTER,
      DISCREPANCY_LEVEL.HIGH,
      `货位 [${location ? location.locationCode : locationId}] 近 ${discrepancies.length} 次复核出现差异，超过阈值 ${threshold}`,
      { refKey: locationId, locationId, locationCode: location ? location.locationCode : null, discrepancyCount: discrepancies.length, threshold }
    );
  }
  return null;
}

function checkAllReviewTimeout() {
  const timeoutMinutes = getConfig('REVIEW_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.REVIEW_TIMEOUT_MINUTES;
  const wavesStore = stores.waves();
  const pendingWaves = wavesStore.find({ status: WAVE_STATUS.TO_CHECK });
  const alerts = [];
  const now = new Date();
  for (const wave of pendingWaves) {
    if (!wave.pickingFinishedAt) continue;
    const diffMinutes = (now - new Date(wave.pickingFinishedAt)) / (1000 * 60);
    if (diffMinutes > timeoutMinutes) {
      alerts.push(createAlert(
        ALERT_TYPES.REVIEW_TIMEOUT,
        DISCREPANCY_LEVEL.MEDIUM,
        `波次 [${wave.waveNo}] 复核超时，已待复核 ${Math.round(diffMinutes)} 分钟，阈值 ${timeoutMinutes} 分钟`,
        { refKey: wave.id, waveId: wave.id, waveNo: wave.waveNo, waitingMinutes: Math.round(diffMinutes), threshold: timeoutMinutes }
      ));
    }
  }
  return alerts;
}

function checkStockoutWithoutExplanation(waveId) {
  const pickingStore = stores.pickingRecords();
  const records = pickingStore.find({ waveId, actualQty: 0 });
  const missing = records.filter(r => !r.stockoutReason || r.stockoutReason.trim() === '');
  if (missing.length > 0) {
    return createAlert(
      ALERT_TYPES.STOCKOUT_NO_EXPLANATION,
      DISCREPANCY_LEVEL.HIGH,
      `波次 [${waveId}] 中有 ${missing.length} 条缺货记录未填写缺货说明`,
      { refKey: waveId, waveId, missingCount: missing.length, recordIds: missing.map(r => r.id) }
    );
  }
  return null;
}

function checkPackingConfirmationMiss() {
  const wavesStore = stores.waves();
  const packingWaves = wavesStore.find({ status: WAVE_STATUS.TO_PACK });
  const alerts = [];
  for (const wave of packingWaves) {
    const checkStore = stores.checkRecords();
    const checks = checkStore.find({ waveId: wave.id });
    const totalSkus = wave.items ? wave.items.length : 0;
    const confirmedPacking = checks.filter(c => c.packingConfirmed === true).length;
    if (totalSkus > 0 && confirmedPacking < totalSkus) {
      alerts.push(createAlert(
        ALERT_TYPES.PACKING_CONFIRM_MISS,
        DISCREPANCY_LEVEL.MEDIUM,
        `波次 [${wave.waveNo}] 待包装状态但仍有 ${totalSkus - confirmedPacking}/${totalSkus} 个SKU未完成包装确认`,
        { refKey: wave.id, waveId: wave.id, waveNo: wave.waveNo, totalSkus, confirmedPacking }
      ));
    }
  }
  return alerts;
}

function runAllChecks() {
  const results = {};
  results.reviewTimeout = checkAllReviewTimeout();
  results.packingMiss = checkPackingConfirmationMiss();
  return results;
}

function resolveAlert(alertId) {
  const store = stores.alerts();
  const alert = store.findById(alertId);
  if (!alert) throw new Error('告警不存在');
  return store.update(alertId, { resolved: true, resolvedAt: new Date().toISOString() });
}

module.exports = {
  ALERT_TYPES,
  getConfig,
  setConfig,
  createAlert,
  checkDuplicateWaveStart,
  checkPathDetour,
  checkLocationDiscrepancyCluster,
  checkAllReviewTimeout,
  checkStockoutWithoutExplanation,
  checkPackingConfirmationMiss,
  runAllChecks,
  resolveAlert
};
