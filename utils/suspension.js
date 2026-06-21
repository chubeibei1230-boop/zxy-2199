const { stores, newId } = require('../models');
const {
  WAVE_STATUS,
  SUSPENSION_REASONS,
  SUSPENSION_STATUS,
  SUSPENDABLE_STATUSES,
  DISCREPANCY_LEVEL,
  CONFIG_DEFAULTS
} = require('../models/constants');

function getConfig(key) {
  const { getConfig: cfgGet } = require('./detector');
  return cfgGet(key);
}

function isWaveSuspended(waveId) {
  const wave = stores.waves().findById(waveId);
  if (!wave) return false;
  return wave.isSuspended === true;
}

function getActiveSuspension(waveId) {
  const suspensions = stores.waveSuspensions().find({
    waveId,
    status: SUSPENSION_STATUS.ACTIVE
  });
  if (suspensions.length > 0) {
    return suspensions[0];
  }
  return null;
}

function getWaveSuspensionTimeline(waveId) {
  const suspensions = stores.waveSuspensions().find({ waveId });
  const timeline = [];
  for (const s of suspensions) {
    timeline.push({
      type: 'suspend',
      timestamp: s.suspendedAt,
      operatorId: s.suspendedBy,
      operatorName: s.suspendedByName,
      reason: s.reason,
      remark: s.remark,
      responsiblePerson: s.responsiblePerson,
      expectedResumeAt: s.expectedResumeAt
    });
    if (s.resumedAt) {
      timeline.push({
        type: 'resume',
        timestamp: s.resumedAt,
        operatorId: s.resumedBy,
        operatorName: s.resumedByName,
        resumeRemark: s.resumeRemark
      });
    }
  }
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return timeline;
}

function suspendWave(waveId, operatorId, operatorName, reason, responsiblePerson, remark, expectedResumeAt) {
  const wavesStore = stores.waves();
  const wave = wavesStore.findById(waveId);
  if (!wave) {
    throw new Error('波次不存在');
  }
  if (wave.isSuspended) {
    throw new Error('波次已处于挂起状态，无需重复挂起');
  }
  if (!SUSPENDABLE_STATUSES.includes(wave.status)) {
    throw new Error(`当前波次状态为"${wave.status}"，只有${SUSPENDABLE_STATUSES.join('、')}状态才能挂起`);
  }
  if (!reason || !SUSPENSION_REASONS.includes(reason)) {
    if (reason !== '其他') {
      throw new Error(`挂起原因必须是: ${SUSPENSION_REASONS.join('、')}`);
    }
  }
  if (!responsiblePerson || String(responsiblePerson).trim() === '') {
    throw new Error('责任人不能为空');
  }
  if (expectedResumeAt) {
    const expectedTime = new Date(expectedResumeAt);
    if (isNaN(expectedTime.getTime())) {
      throw new Error('预计恢复时间格式不正确');
    }
    if (expectedTime <= new Date()) {
      throw new Error('预计恢复时间必须晚于当前时间');
    }
  }
  const suspensionId = newId();
  const suspension = stores.waveSuspensions().create({
    id: suspensionId,
    waveId,
    waveNo: wave.waveNo,
    status: SUSPENSION_STATUS.ACTIVE,
    reason,
    responsiblePerson,
    remark: remark || '',
    expectedResumeAt: expectedResumeAt || null,
    suspendedBy: operatorId,
    suspendedByName: operatorName || '',
    suspendedAt: new Date().toISOString(),
    resumedBy: null,
    resumedByName: null,
    resumedAt: null,
    resumeRemark: '',
    suspensionDurationMinutes: null
  });
  wavesStore.update(waveId, {
    isSuspended: true,
    currentSuspensionId: suspensionId,
    suspensionCount: (wave.suspensionCount || 0) + 1
  });
  return { wave: wavesStore.findById(waveId), suspension };
}

function resumeWave(waveId, operatorId, operatorName, resumeRemark) {
  const wavesStore = stores.waves();
  const wave = wavesStore.findById(waveId);
  if (!wave) {
    throw new Error('波次不存在');
  }
  if (!wave.isSuspended) {
    throw new Error('波次未处于挂起状态，无需恢复');
  }
  const suspension = getActiveSuspension(waveId);
  if (!suspension) {
    throw new Error('未找到有效的挂起记录');
  }
  const now = new Date();
  const suspendedAt = new Date(suspension.suspendedAt);
  const durationMinutes = Math.round((now - suspendedAt) / (1000 * 60));
  stores.waveSuspensions().update(suspension.id, {
    status: SUSPENSION_STATUS.RESUMED,
    resumedBy: operatorId,
    resumedByName: operatorName || '',
    resumedAt: now.toISOString(),
    resumeRemark: resumeRemark || '',
    suspensionDurationMinutes: durationMinutes
  });
  const updatedWave = wavesStore.update(waveId, {
    isSuspended: false,
    currentSuspensionId: null,
    totalSuspensionMinutes: (wave.totalSuspensionMinutes || 0) + durationMinutes
  });
  return { wave: updatedWave, suspension: stores.waveSuspensions().findById(suspension.id) };
}

function checkSuspensionTimeout() {
  const timeoutMinutes = getConfig('SUSPENSION_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.SUSPENSION_TIMEOUT_MINUTES;
  const suspensions = stores.waveSuspensions().find({
    status: SUSPENSION_STATUS.ACTIVE
  });
  const alerts = [];
  const now = new Date();
  for (const s of suspensions) {
    const suspendedMinutes = Math.round((now - new Date(s.suspendedAt)) / (1000 * 60));
    if (suspendedMinutes > timeoutMinutes) {
      const { createAlert } = require('./detector');
      alerts.push(createAlert(
        'SUSPENSION_TIMEOUT',
        DISCREPANCY_LEVEL.HIGH,
        `波次 [${s.waveNo}] 挂起超时，已挂起 ${suspendedMinutes} 分钟，阈值 ${timeoutMinutes} 分钟`,
        {
          refKey: s.id,
          suspensionId: s.id,
          waveId: s.waveId,
          waveNo: s.waveNo,
          reason: s.reason,
          suspendedMinutes,
          threshold: timeoutMinutes,
          responsiblePerson: s.responsiblePerson,
          expectedResumeAt: s.expectedResumeAt
        }
      ));
    }
  }
  return alerts;
}

function getSuspensionList(filters = {}, page = 1, pageSize = 20) {
  const store = stores.waveSuspensions();
  let all = store.findAll();
  if (filters.waveId) all = all.filter(s => s.waveId === filters.waveId);
  if (filters.waveNo) all = all.filter(s => String(s.waveNo || '').includes(filters.waveNo));
  if (filters.status) all = all.filter(s => s.status === filters.status);
  if (filters.reason) all = all.filter(s => s.reason === filters.reason);
  if (filters.responsiblePerson) {
    all = all.filter(s => String(s.responsiblePerson || '').includes(filters.responsiblePerson));
  }
  if (filters.suspendedBy) all = all.filter(s => s.suspendedBy === filters.suspendedBy);
  if (filters.startDate) {
    const sd = new Date(filters.startDate);
    all = all.filter(s => new Date(s.suspendedAt) >= sd);
  }
  if (filters.endDate) {
    const ed = new Date(filters.endDate);
    ed.setHours(23, 59, 59, 999);
    all = all.filter(s => new Date(s.suspendedAt) <= ed);
  }
  all.sort((a, b) => new Date(b.suspendedAt) - new Date(a.suspendedAt));
  const total = all.length;
  const data = all.slice((page - 1) * pageSize, page * pageSize);
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function canSuspendWave(wave, userRole, userId) {
  if (!wave || !SUSPENDABLE_STATUSES.includes(wave.status)) {
    return { allowed: false, reason: '当前状态不可挂起' };
  }
  if (wave.isSuspended) {
    return { allowed: false, reason: '波次已挂起' };
  }
  if (userRole === 'admin') {
    return { allowed: true };
  }
  if (userRole === 'picker' && wave.status === WAVE_STATUS.PICKING) {
    if (wave.pickerId && wave.pickerId === userId) {
      return { allowed: true };
    }
    return { allowed: false, reason: '只能挂起自己负责的拣货波次' };
  }
  if (userRole === 'checker' && (wave.status === WAVE_STATUS.TO_CHECK || wave.status === WAVE_STATUS.DISCREPANCY)) {
    if (wave.checkerId && wave.checkerId === userId) {
      return { allowed: true };
    }
    return { allowed: false, reason: '只能挂起自己负责的复核波次' };
  }
  return { allowed: false, reason: '权限不足' };
}

function canResumeWave(wave, userRole, userId) {
  if (!wave || !wave.isSuspended) {
    return { allowed: false, reason: '波次未挂起' };
  }
  if (userRole === 'admin') {
    return { allowed: true };
  }
  const suspension = getActiveSuspension(wave.id);
  if (suspension && suspension.suspendedBy === userId) {
    return { allowed: true };
  }
  if (userRole === 'picker' && wave.status === WAVE_STATUS.PICKING && wave.pickerId === userId) {
    return { allowed: true };
  }
  if (userRole === 'checker' && (wave.status === WAVE_STATUS.TO_CHECK || wave.status === WAVE_STATUS.DISCREPANCY) && wave.checkerId === userId) {
    return { allowed: true };
  }
  return { allowed: false, reason: '权限不足，只能由挂起人或管理员恢复' };
}

module.exports = {
  isWaveSuspended,
  getActiveSuspension,
  getWaveSuspensionTimeline,
  suspendWave,
  resumeWave,
  checkSuspensionTimeout,
  getSuspensionList,
  canSuspendWave,
  canResumeWave
};
