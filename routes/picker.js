const express = require('express');
const router = express.Router();
const { requirePicker, requireAdmin, validateBody, authMiddleware } = require('../middleware/auth');
const { stores, newId } = require('../models');
const { WAVE_STATUS, STOCKOUT_REASONS, PATH_DEVIATION_REASONS, SUSPENSION_REASONS } = require('../models/constants');
const { checkDuplicateWaveStart, checkPathDetour, checkStockoutWithoutExplanation } = require('../utils/detector');
const { suspendWave, resumeWave, canSuspendWave, canResumeWave, getActiveSuspension, getWaveSuspensionTimeline } = require('../utils/suspension');

function generateWaveNo() {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const store = stores.waves();
  const todayCount = store.find({
    createdAt: { $gte: new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString() }
  }).length + 1;
  return `W${ymd}${String(todayCount).padStart(4, '0')}`;
}

function requireWavePicker(wave, userId) {
  if (!wave) {
    return { allowed: false, reason: '波次不存在' };
  }
  if (!wave.pickerId) {
    return { allowed: true };
  }
  if (wave.pickerId !== userId) {
    return { allowed: false, reason: '该波次已转派给其他拣货员，您无权操作' };
  }
  return { allowed: true };
}

router.post('/waves', requireAdmin, validateBody({
  items: { required: true, type: 'array' }
}), (req, res, next) => {
  try {
    const { waveRuleId = null, zoneId = null, pickerId = null, checkerId = null,
            priority = 5, remark = '', items = [] } = req.body;
    const waveNo = generateWaveNo();
    const skuStore = stores.skus();
    const locStore = stores.locations();
    const validatedItems = items.map((it, idx) => {
      if (!it.skuId) throw new Error(`第 ${idx + 1} 行缺少 skuId`);
      const sku = skuStore.findById(it.skuId);
      if (!sku) throw new Error(`第 ${idx + 1} 行 SKU 不存在: ${it.skuId}`);
      const locationId = it.locationId || sku.defaultLocationId;
      if (!locationId) throw new Error(`第 ${idx + 1} 行缺少货位且SKU无默认货位`);
      const loc = locStore.findById(locationId);
      if (!loc) throw new Error(`第 ${idx + 1} 行货位不存在: ${locationId}`);
      return {
        pickItemId: newId(),
        skuId: it.skuId,
        skuCode: sku.skuCode,
        skuName: sku.skuName,
        locationId,
        locationCode: loc.locationCode,
        planQty: Number(it.planQty) || 0,
        actualQty: null,
        status: 'pending',
        picked: false,
        checked: false
      };
    });
    const wave = stores.waves().create({
      id: newId(),
      waveNo,
      waveRuleId,
      zoneId,
      pickerId,
      checkerId,
      priority,
      remark,
      items: validatedItems,
      status: WAVE_STATUS.PENDING,
      pickingStartedAt: null,
      pickingFinishedAt: null,
      checkingStartedAt: null,
      checkingFinishedAt: null,
      closedAt: null,
      totalPlanQty: validatedItems.reduce((s, i) => s + i.planQty, 0),
      totalActualQty: 0,
      discrepancyCount: 0
    });
    res.status(201).json({ data: wave });
  } catch (e) { next(e); }
});

router.post('/waves/:id/start-picking', requirePicker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const pickerId = req.user.id;
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const pickerAuth = requireWavePicker(wave, pickerId);
    if (!pickerAuth.allowed) return res.status(403).json({ error: pickerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法开始拣货，请先恢复波次' });
    }
    const duplicateAlert = checkDuplicateWaveStart(waveId);
    if (duplicateAlert) {
      return res.status(409).json({
        error: `波次已处于"${wave.status}"状态，禁止重复开启`,
        alert: duplicateAlert
      });
    }
    if (wave.status !== WAVE_STATUS.PENDING) {
      return res.status(400).json({ error: `当前波次状态为 ${wave.status}，只能从"待拣货"开始` });
    }
    const updated = wavesStore.update(waveId, {
      status: WAVE_STATUS.PICKING,
      pickerId: wave.pickerId || pickerId,
      pickingStartedAt: new Date().toISOString()
    });
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post('/waves/:id/scan-location', requirePicker, validateBody({
  pickItemId: { required: true, minLength: 1 },
  scannedLocationCode: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const waveId = req.params.id;
    const pickerId = req.user.id;
    const { pickItemId, scannedLocationCode, pathDeviation = false, pathDeviationReason = '' } = req.body;
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const pickerAuth = requireWavePicker(wave, pickerId);
    if (!pickerAuth.allowed) return res.status(403).json({ error: pickerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法进行拣货扫描，请先恢复波次' });
    }
    if (wave.status !== WAVE_STATUS.PICKING) return res.status(400).json({ error: '波次不在拣货中状态' });
    const item = wave.items.find(i => i.pickItemId === pickItemId);
    if (!item) return res.status(404).json({ error: '拣货明细不存在' });
    const locStore = stores.locations();
    const scannedLoc = locStore.findOne({ locationCode: scannedLocationCode });
    if (!scannedLoc) return res.status(404).json({ error: '扫描的货位编码不存在' });
    const locationMatched = scannedLoc.id === item.locationId;
    if (!locationMatched && !pathDeviation) {
      return res.status(400).json({
        error: '扫描货位与计划货位不一致，需确认是否路径偏离',
        expected: item.locationCode,
        scanned: scannedLocationCode
      });
    }
    if (pathDeviation && pathDeviationReason && !PATH_DEVIATION_REASONS.includes(pathDeviationReason) && pathDeviationReason !== '其他') {
      return res.status(400).json({ error: `路径偏离原因必须是: ${PATH_DEVIATION_REASONS.join(', ')}` });
    }
    const pickRecord = stores.pickingRecords().create({
      id: newId(),
      waveId,
      waveNo: wave.waveNo,
      pickItemId,
      skuId: item.skuId,
      skuCode: item.skuCode,
      locationId: item.locationId,
      plannedLocationCode: item.locationCode,
      scannedLocationId: scannedLoc.id,
      scannedLocationCode,
      pickerId: req.user.id,
      locationMatched,
      pathDeviation,
      pathDeviationReason: pathDeviation ? pathDeviationReason : '',
      scannedAt: new Date().toISOString(),
      actualQty: null,
      stockoutReason: '',
      remark: req.body.remark || ''
    });
    if (pathDeviation) {
      checkPathDetour(waveId, req.user.id);
    }
    res.json({ data: pickRecord, locationMatched });
  } catch (e) { next(e); }
});

router.post('/picking-records/:id/submit-qty', requirePicker, validateBody({
  actualQty: { required: true, type: 'integer', min: 0 }
}), (req, res, next) => {
  try {
    const pickerId = req.user.id;
    const { actualQty, stockoutReason = '', remark = '' } = req.body;
    const recordsStore = stores.pickingRecords();
    const record = recordsStore.findById(req.params.id);
    if (!record) return res.status(404).json({ error: '拣货记录不存在' });
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(record.waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const pickerAuth = requireWavePicker(wave, pickerId);
    if (!pickerAuth.allowed) return res.status(403).json({ error: pickerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法提交拣货数量，请先恢复波次' });
    }
    if (record.actualQty !== null && record.actualQty !== undefined) {
      return res.status(409).json({ error: '该货位已提交过数量，如需修改请使用更新接口' });
    }
    if (actualQty === 0 && !stockoutReason) {
      return res.status(400).json({ error: '实际数量为0时必须填写缺货说明' });
    }
    if (actualQty === 0 && stockoutReason && !STOCKOUT_REASONS.includes(stockoutReason) && stockoutReason !== '其他') {
      return res.status(400).json({ error: `缺货原因必须是: ${STOCKOUT_REASONS.join(', ')}` });
    }
    const updatedItems = wave.items.map(it => {
      if (it.pickItemId === record.pickItemId) {
        return { ...it, actualQty, picked: true, status: 'picked' };
      }
      return it;
    });
    const totalActualQty = updatedItems.reduce((s, i) => s + (i.actualQty || 0), 0);
    const discrepancyCount = updatedItems.filter(i => i.picked && i.actualQty !== i.planQty).length;
    wavesStore.update(record.waveId, {
      items: updatedItems,
      totalActualQty,
      discrepancyCount
    });
    const updatedRecord = recordsStore.update(record.id, {
      actualQty,
      stockoutReason,
      remark,
      submittedAt: new Date().toISOString()
    });
    checkStockoutWithoutExplanation(record.waveId);
    res.json({ data: updatedRecord });
  } catch (e) { next(e); }
});

router.put('/picking-records/:id', requirePicker, (req, res, next) => {
  try {
    const pickerId = req.user.id;
    const record = stores.pickingRecords().findById(req.params.id);
    if (!record) return res.status(404).json({ error: '拣货记录不存在' });
    const wave = stores.waves().findById(record.waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const pickerAuth = requireWavePicker(wave, pickerId);
    if (!pickerAuth.allowed) return res.status(403).json({ error: pickerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法修改拣货记录，请先恢复波次' });
    }
    const updated = stores.pickingRecords().update(req.params.id, req.body);
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post('/waves/:id/finish-picking', requirePicker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const pickerId = req.user.id;
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const pickerAuth = requireWavePicker(wave, pickerId);
    if (!pickerAuth.allowed) return res.status(403).json({ error: pickerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法完成拣货，请先恢复波次' });
    }
    if (wave.status !== WAVE_STATUS.PICKING) return res.status(400).json({ error: '波次不在拣货中状态' });
    const unpicked = wave.items.filter(i => !i.picked);
    if (unpicked.length > 0) {
      return res.status(400).json({
        error: `仍有 ${unpicked.length} 项未完成拣货`,
        unpickedItems: unpicked.map(i => ({ pickItemId: i.pickItemId, skuCode: i.skuCode, locationCode: i.locationCode }))
      });
    }
    const stockoutAlert = checkStockoutWithoutExplanation(waveId);
    if (stockoutAlert) {
      return res.status(400).json({
        error: '存在缺货记录未填写说明，无法完成拣货',
        alert: stockoutAlert
      });
    }
    const updated = wavesStore.update(waveId, {
      status: WAVE_STATUS.TO_CHECK,
      pickingFinishedAt: new Date().toISOString()
    });
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.get('/waves/my-pending', requirePicker, (req, res, next) => {
  try {
    const filter = {
      $or: [
        { pickerId: req.user.id },
        { status: WAVE_STATUS.PENDING }
      ]
    };
    const waves = stores.waves().find({
      status: { $in: [WAVE_STATUS.PENDING, WAVE_STATUS.PICKING] },
      ...(req.query.includeAll ? {} : { pickerId: req.user.id })
    });
    if (!req.query.includeAll) {
      const filtered = waves.filter(w => !w.pickerId || w.pickerId === req.user.id);
      res.json({ data: filtered, total: filtered.length });
    } else {
      res.json({ data: waves, total: waves.length });
    }
  } catch (e) { next(e); }
});

router.get('/picking-records/wave/:waveId', authMiddleware(), (req, res, next) => {
  try {
    const records = stores.pickingRecords().find({ waveId: req.params.waveId });
    res.json({ data: records, total: records.length });
  } catch (e) { next(e); }
});

router.post('/waves/:id/suspend', requirePicker, validateBody({
  reason: { required: true, minLength: 1 },
  responsiblePerson: { required: true, minLength: 1 },
  remark: { required: true, minLength: 1 },
  expectedResumeAt: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const permission = canSuspendWave(wave, req.user.role, req.user.id);
    if (!permission.allowed) {
      return res.status(403).json({ error: permission.reason });
    }
    const { reason, responsiblePerson, remark = '', expectedResumeAt = null } = req.body;
    const result = suspendWave(
      waveId,
      req.user.id,
      req.user.realName || req.user.username,
      reason,
      responsiblePerson,
      remark,
      expectedResumeAt
    );
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post('/waves/:id/resume', requirePicker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const permission = canResumeWave(wave, req.user.role, req.user.id);
    if (!permission.allowed) {
      return res.status(403).json({ error: permission.reason });
    }
    const { resumeRemark = '' } = req.body;
    const result = resumeWave(
      waveId,
      req.user.id,
      req.user.realName || req.user.username,
      resumeRemark
    );
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.get('/waves/:id/suspension-timeline', requirePicker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    if (wave.pickerId && wave.pickerId !== req.user.id) {
      return res.status(403).json({ error: '只能查看自己负责的波次挂起记录' });
    }
    const timeline = getWaveSuspensionTimeline(waveId);
    const activeSuspension = getActiveSuspension(waveId);
    res.json({ data: { timeline, activeSuspension } });
  } catch (e) { next(e); }
});

router.get('/suspension-reasons', requirePicker, (req, res, next) => {
  try {
    res.json({ data: SUSPENSION_REASONS });
  } catch (e) { next(e); }
});

module.exports = router;
