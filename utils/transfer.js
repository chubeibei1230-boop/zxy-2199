const { stores, newId } = require('../models');
const {
  WAVE_STATUS,
  TRANSFER_REASONS,
  TRANSFER_STATUS,
  TRANSFER_REJECT_REASONS,
  TRANSFERABLE_ROLES,
  TRANSFERABLE_STATUSES,
  ROLES,
  CONFIG_DEFAULTS,
  DISCREPANCY_LEVEL
} = require('../models/constants');

function getConfig(key) {
  const { getConfig: cfgGet } = require('./detector');
  return cfgGet(key);
}

function canTransferWave(wave, targetRole) {
  if (!wave) {
    return { allowed: false, reason: '波次不存在' };
  }
  if (wave.status === WAVE_STATUS.CLOSED) {
    return { allowed: false, reason: '已关闭的波次不可转派' };
  }
  if (!TRANSFERABLE_STATUSES.includes(wave.status)) {
    return { allowed: false, reason: `当前波次状态"${wave.status}"不可转派` };
  }
  if (!TRANSFERABLE_ROLES.includes(targetRole)) {
    return { allowed: false, reason: `转派目标角色必须是: ${TRANSFERABLE_ROLES.join('、')}` };
  }
  if (wave.status === WAVE_STATUS.PENDING || wave.status === WAVE_STATUS.PICKING) {
    if (targetRole !== ROLES.PICKER) {
      return { allowed: false, reason: '待拣货或拣货中的波次只能转派给拣货员' };
    }
  }
  if (wave.status === WAVE_STATUS.TO_CHECK || wave.status === WAVE_STATUS.DISCREPANCY || wave.status === WAVE_STATUS.TO_PACK) {
    if (targetRole !== ROLES.CHECKER) {
      return { allowed: false, reason: '待复核、差异处理中或可包装的波次只能转派给复核员' };
    }
  }
  if (wave.isSuspended) {
    return { allowed: false, reason: '波次当前处于挂起状态，请先恢复波次后再转派' };
  }
  return { allowed: true, isSuspended: false };
}

function getActiveTransfer(waveId) {
  const transfers = stores.waveTransfers().find({
    waveId,
    status: TRANSFER_STATUS.PENDING
  });
  if (transfers.length > 0) {
    return transfers[0];
  }
  return null;
}

function hasPendingTransfer(waveId) {
  return getActiveTransfer(waveId) !== null;
}

function initiateTransfer(waveId, operatorId, operatorName, targetUserId, targetRole, reason, remark) {
  const wavesStore = stores.waves();
  const wave = wavesStore.findById(waveId);
  if (!wave) {
    throw new Error('波次不存在');
  }

  const permission = canTransferWave(wave, targetRole);
  if (!permission.allowed) {
    throw new Error(permission.reason);
  }

  if (!reason || (!TRANSFER_REASONS.includes(reason) && reason !== '其他')) {
    throw new Error(`转派原因必须是: ${TRANSFER_REASONS.join('、')}`);
  }

  if (hasPendingTransfer(waveId)) {
    throw new Error('该波次存在待接收的转派，请先处理后再发起新的转派');
  }

  const targetUser = stores.users().findById(targetUserId);
  if (!targetUser) {
    throw new Error('目标用户不存在');
  }
  if (!targetUser.active) {
    throw new Error('目标用户已被禁用');
  }
  if (targetUser.role !== targetRole) {
    throw new Error(`目标用户角色为${targetUser.role}，与指定角色${targetRole}不匹配`);
  }

  let originalUserId = null;
  let originalUserName = null;
  let targetField = null;

  if (targetRole === ROLES.PICKER) {
    originalUserId = wave.pickerId || null;
    targetField = 'pickerId';
  } else if (targetRole === ROLES.CHECKER) {
    originalUserId = wave.checkerId || null;
    targetField = 'checkerId';
  }

  if (originalUserId === targetUserId) {
    throw new Error('转派目标与当前负责人相同，无需转派');
  }

  if (originalUserId) {
    const originalUser = stores.users().findById(originalUserId);
    if (originalUser) {
      originalUserName = originalUser.realName || originalUser.username;
    }
  }

  const transferId = newId();
  const now = new Date().toISOString();
  const transferRecord = stores.waveTransfers().create({
    id: transferId,
    waveId,
    waveNo: wave.waveNo,
    transferRole: targetRole,
    reason,
    remark: remark || '',
    operatorId,
    operatorName: operatorName || '',
    originalUserId,
    originalUserName: originalUserName || '',
    newUserId: targetUserId,
    newUserName: targetUser.realName || targetUser.username,
    transferredAt: now,
    waveStatusAtTransfer: wave.status,
    isSuspendedAtTransfer: wave.isSuspended === true,
    currentSuspensionId: wave.currentSuspensionId || null,
    status: TRANSFER_STATUS.PENDING,
    handledAt: null,
    handledBy: null,
    handledByName: null,
    rejectReason: '',
    rejectRemark: '',
    processingDurationMinutes: null
  });

  wavesStore.update(waveId, {
    pendingTransferId: transferId,
    transferCount: (wave.transferCount || 0) + 1,
    lastTransferId: transferId,
    lastTransferAt: transferRecord.transferredAt
  });

  return { wave: wavesStore.findById(waveId), transfer: transferRecord };
}

function acceptTransfer(transferId, userId, userName) {
  const transfersStore = stores.waveTransfers();
  const transfer = transfersStore.findById(transferId);
  if (!transfer) {
    throw new Error('转派记录不存在');
  }
  if (transfer.status !== TRANSFER_STATUS.PENDING) {
    throw new Error(`该转派已${transfer.status}，无法重复处理`);
  }
  if (transfer.newUserId !== userId) {
    throw new Error('您不是该转派的目标人员，无权接收');
  }

  const wavesStore = stores.waves();
  const wave = wavesStore.findById(transfer.waveId);
  if (!wave) {
    throw new Error('波次不存在');
  }

  const now = new Date();
  const transferredAt = new Date(transfer.transferredAt);
  const durationMinutes = Math.round((now - transferredAt) / (1000 * 60));

  const updatedTransfer = transfersStore.update(transferId, {
    status: TRANSFER_STATUS.ACCEPTED,
    handledAt: now.toISOString(),
    handledBy: userId,
    handledByName: userName || '',
    processingDurationMinutes: durationMinutes
  });

  let targetField = null;
  if (transfer.transferRole === ROLES.PICKER) {
    targetField = 'pickerId';
  } else if (transfer.transferRole === ROLES.CHECKER) {
    targetField = 'checkerId';
  }

  const updateData = {
    pendingTransferId: null
  };
  if (targetField) {
    updateData[targetField] = transfer.newUserId;
  }
  const updatedWave = wavesStore.update(transfer.waveId, updateData);

  return { wave: updatedWave, transfer: updatedTransfer };
}

function rejectTransfer(transferId, userId, userName, rejectReason, rejectRemark) {
  const transfersStore = stores.waveTransfers();
  const transfer = transfersStore.findById(transferId);
  if (!transfer) {
    throw new Error('转派记录不存在');
  }
  if (transfer.status !== TRANSFER_STATUS.PENDING) {
    throw new Error(`该转派已${transfer.status}，无法重复处理`);
  }
  if (transfer.newUserId !== userId) {
    throw new Error('您不是该转派的目标人员，无权拒绝');
  }

  if (!rejectReason || (!TRANSFER_REJECT_REASONS.includes(rejectReason) && rejectReason !== '其他')) {
    throw new Error(`拒绝原因必须是: ${TRANSFER_REJECT_REASONS.join('、')}`);
  }
  if (!rejectRemark || String(rejectRemark).trim() === '') {
    throw new Error('请填写拒绝说明');
  }

  const wavesStore = stores.waves();
  const wave = wavesStore.findById(transfer.waveId);
  if (!wave) {
    throw new Error('波次不存在');
  }

  const now = new Date();
  const transferredAt = new Date(transfer.transferredAt);
  const durationMinutes = Math.round((now - transferredAt) / (1000 * 60));

  const updatedTransfer = transfersStore.update(transferId, {
    status: TRANSFER_STATUS.REJECTED,
    handledAt: now.toISOString(),
    handledBy: userId,
    handledByName: userName || '',
    rejectReason,
    rejectRemark,
    processingDurationMinutes: durationMinutes
  });

  wavesStore.update(transfer.waveId, {
    pendingTransferId: null
  });

  return { wave: wavesStore.findById(transfer.waveId), transfer: updatedTransfer };
}

function checkAllTransferTimeout() {
  const timeoutMinutes = getConfig('TRANSFER_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.TRANSFER_TIMEOUT_MINUTES;
  const transfersStore = stores.waveTransfers();
  const pendingTransfers = transfersStore.find({
    status: TRANSFER_STATUS.PENDING
  });
  const alerts = [];
  const now = new Date();
  const { createAlert } = require('./detector');

  for (const t of pendingTransfers) {
    const pendingMinutes = Math.round((now - new Date(t.transferredAt)) / (1000 * 60));
    if (pendingMinutes > timeoutMinutes) {
      transfersStore.update(t.id, {
        status: TRANSFER_STATUS.TIMEOUT,
        handledAt: now.toISOString(),
        handledBy: 'system',
        handledByName: '系统自动',
        rejectReason: '超时未处理',
        rejectRemark: `转派发起后 ${pendingMinutes} 分钟未处理，系统自动标记为超时`,
        processingDurationMinutes: pendingMinutes
      });

      const wavesStore = stores.waves();
      const wave = wavesStore.findById(t.waveId);
      if (wave && wave.pendingTransferId === t.id) {
        wavesStore.update(t.waveId, {
          pendingTransferId: null
        });
      }

      alerts.push(createAlert(
        'TRANSFER_TIMEOUT',
        DISCREPANCY_LEVEL.MEDIUM,
        `波次 [${t.waveNo}] 转派超时，待接收 ${pendingMinutes} 分钟，阈值 ${timeoutMinutes} 分钟`,
        {
          refKey: t.id,
          transferId: t.id,
          waveId: t.waveId,
          waveNo: t.waveNo,
          targetUserId: t.newUserId,
          targetUserName: t.newUserName,
          transferRole: t.transferRole,
          pendingMinutes,
          threshold: timeoutMinutes,
          operatorId: t.operatorId,
          operatorName: t.operatorName
        }
      ));
    }
  }
  return alerts;
}

function getWaveTransferHistory(waveId) {
  const transfers = stores.waveTransfers().find({ waveId });
  transfers.sort((a, b) => new Date(a.transferredAt) - new Date(b.transferredAt));
  return transfers;
}

function getLatestTransfer(waveId) {
  const transfers = stores.waveTransfers().find({ waveId });
  if (transfers.length === 0) return null;
  transfers.sort((a, b) => new Date(b.transferredAt) - new Date(a.transferredAt));
  return transfers[0];
}

function getPendingTransferForUser(userId, role) {
  const filters = {
    newUserId: userId,
    status: TRANSFER_STATUS.PENDING
  };
  if (role && role !== 'admin') {
    filters.transferRole = role;
  }
  const transfers = stores.waveTransfers().find(filters);
  transfers.sort((a, b) => new Date(a.transferredAt) - new Date(b.transferredAt));
  return transfers;
}

function getMyTransferList(userId, role, filters = {}, page = 1, pageSize = 20) {
  const store = stores.waveTransfers();
  let all = store.findAll();

  all = all.filter(t => t.newUserId === userId || t.originalUserId === userId || t.operatorId === userId);

  if (role && role !== 'admin') {
    all = all.filter(t => t.transferRole === role);
  }

  if (filters.status) all = all.filter(t => t.status === filters.status);
  if (filters.transferRole) all = all.filter(t => t.transferRole === filters.transferRole);
  if (filters.reason) all = all.filter(t => t.reason === filters.reason);
  if (filters.waveId) all = all.filter(t => t.waveId === filters.waveId);
  if (filters.waveNo) all = all.filter(t => String(t.waveNo || '').includes(filters.waveNo));
  if (filters.type === 'pending') {
    all = all.filter(t => t.status === TRANSFER_STATUS.PENDING && t.newUserId === userId);
  } else if (filters.type === 'handled') {
    all = all.filter(t => t.status !== TRANSFER_STATUS.PENDING && t.newUserId === userId);
  } else if (filters.type === 'initiated') {
    all = all.filter(t => t.operatorId === userId);
  } else if (filters.type === 'received') {
    all = all.filter(t => t.newUserId === userId);
  }

  if (filters.startDate) {
    const sd = new Date(filters.startDate);
    all = all.filter(t => new Date(t.transferredAt) >= sd);
  }
  if (filters.endDate) {
    const ed = new Date(filters.endDate);
    ed.setHours(23, 59, 59, 999);
    all = all.filter(t => new Date(t.transferredAt) <= ed);
  }

  all.sort((a, b) => new Date(b.transferredAt) - new Date(a.transferredAt));
  const total = all.length;
  const data = all.slice((page - 1) * pageSize, page * pageSize);
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function getTransferList(filters = {}, page = 1, pageSize = 20) {
  const store = stores.waveTransfers();
  let all = store.findAll();

  if (filters.waveId) all = all.filter(t => t.waveId === filters.waveId);
  if (filters.waveIds && Array.isArray(filters.waveIds)) {
    all = all.filter(t => filters.waveIds.includes(t.waveId));
  }
  if (filters.waveNo) all = all.filter(t => String(t.waveNo || '').includes(filters.waveNo));
  if (filters.transferRole) all = all.filter(t => t.transferRole === filters.transferRole);
  if (filters.reason) all = all.filter(t => t.reason === filters.reason);
  if (filters.operatorId) all = all.filter(t => t.operatorId === filters.operatorId);
  if (filters.originalUserId) all = all.filter(t => t.originalUserId === filters.originalUserId);
  if (filters.newUserId) all = all.filter(t => t.newUserId === filters.newUserId);
  if (filters.userId) {
    all = all.filter(t => t.originalUserId === filters.userId || t.newUserId === filters.userId);
  }
  if (filters.status) all = all.filter(t => t.status === filters.status);
  if (filters.isTimeout !== undefined) {
    const isTimeout = filters.isTimeout === 'true' || filters.isTimeout === true;
    if (isTimeout) {
      all = all.filter(t => t.status === TRANSFER_STATUS.TIMEOUT);
    } else {
      all = all.filter(t => t.status !== TRANSFER_STATUS.TIMEOUT);
    }
  }
  if (filters.waveStatusAtTransfer) {
    all = all.filter(t => t.waveStatusAtTransfer === filters.waveStatusAtTransfer);
  }
  if (filters.isSuspendedAtTransfer !== undefined && filters.isSuspendedAtTransfer !== null) {
    all = all.filter(t => t.isSuspendedAtTransfer === (filters.isSuspendedAtTransfer === 'true' || filters.isSuspendedAtTransfer === true));
  }
  if (filters.startDate) {
    const sd = new Date(filters.startDate);
    all = all.filter(t => new Date(t.transferredAt) >= sd);
  }
  if (filters.endDate) {
    const ed = new Date(filters.endDate);
    ed.setHours(23, 59, 59, 999);
    all = all.filter(t => new Date(t.transferredAt) <= ed);
  }

  all.sort((a, b) => new Date(b.transferredAt) - new Date(a.transferredAt));
  const total = all.length;
  const data = all.slice((page - 1) * pageSize, page * pageSize);
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function enrichTransferWithUsers(transfers) {
  const usersStore = stores.users();
  return transfers.map(t => {
    const enriched = { ...t };
    if (t.operatorId) {
      const u = usersStore.findById(t.operatorId);
      if (u) enriched.operatorUser = { id: u.id, username: u.username, realName: u.realName, role: u.role };
    }
    if (t.originalUserId) {
      const u = usersStore.findById(t.originalUserId);
      if (u) enriched.originalUser = { id: u.id, username: u.username, realName: u.realName, role: u.role };
    }
    if (t.newUserId) {
      const u = usersStore.findById(t.newUserId);
      if (u) enriched.newUser = { id: u.id, username: u.username, realName: u.realName, role: u.role };
    }
    if (t.handledBy && t.handledBy !== 'system') {
      const u = usersStore.findById(t.handledBy);
      if (u) enriched.handledByUser = { id: u.id, username: u.username, realName: u.realName, role: u.role };
    }
    return enriched;
  });
}

function getUserTransferStats(userId, startDate, endDate) {
  let transfers = stores.waveTransfers().findAll();
  if (userId) {
    transfers = transfers.filter(t => t.originalUserId === userId || t.newUserId === userId);
  }
  if (startDate) {
    const sd = new Date(startDate);
    transfers = transfers.filter(t => new Date(t.transferredAt) >= sd);
  }
  if (endDate) {
    const ed = new Date(endDate);
    ed.setHours(23, 59, 59, 999);
    transfers = transfers.filter(t => new Date(t.transferredAt) <= ed);
  }

  const asOriginal = transfers.filter(t => t.originalUserId === userId).length;
  const asNew = transfers.filter(t => t.newUserId === userId).length;
  const pendingCount = transfers.filter(t => t.newUserId === userId && t.status === TRANSFER_STATUS.PENDING).length;
  const acceptedCount = transfers.filter(t => t.newUserId === userId && t.status === TRANSFER_STATUS.ACCEPTED).length;
  const rejectedCount = transfers.filter(t => t.newUserId === userId && t.status === TRANSFER_STATUS.REJECTED).length;
  const timeoutCount = transfers.filter(t => t.newUserId === userId && t.status === TRANSFER_STATUS.TIMEOUT).length;

  const handledTransfers = transfers.filter(t => 
    t.newUserId === userId && 
    t.processingDurationMinutes !== null && 
    t.processingDurationMinutes !== undefined
  );
  let avgProcessingMinutes = 0;
  if (handledTransfers.length > 0) {
    const totalDuration = handledTransfers.reduce((sum, t) => sum + t.processingDurationMinutes, 0);
    avgProcessingMinutes = Math.round(totalDuration / handledTransfers.length);
  }

  return {
    totalTransfers: transfers.length,
    asOriginalCount: asOriginal,
    asNewCount: asNew,
    pendingCount,
    acceptedCount,
    rejectedCount,
    timeoutCount,
    avgProcessingMinutes
  };
}

function getTransferStats(filters = {}) {
  let transfers = stores.waveTransfers().findAll();

  if (filters.startDate) {
    const sd = new Date(filters.startDate);
    transfers = transfers.filter(t => new Date(t.transferredAt) >= sd);
  }
  if (filters.endDate) {
    const ed = new Date(filters.endDate);
    ed.setHours(23, 59, 59, 999);
    transfers = transfers.filter(t => new Date(t.transferredAt) <= ed);
  }
  if (filters.transferRole) {
    transfers = transfers.filter(t => t.transferRole === filters.transferRole);
  }
  if (filters.operatorId) {
    transfers = transfers.filter(t => t.operatorId === filters.operatorId);
  }

  const total = transfers.length;
  const pending = transfers.filter(t => t.status === TRANSFER_STATUS.PENDING).length;
  const accepted = transfers.filter(t => t.status === TRANSFER_STATUS.ACCEPTED).length;
  const rejected = transfers.filter(t => t.status === TRANSFER_STATUS.REJECTED).length;
  const timeout = transfers.filter(t => t.status === TRANSFER_STATUS.TIMEOUT).length;

  const handled = transfers.filter(t => t.processingDurationMinutes !== null && t.processingDurationMinutes !== undefined);
  let avgDuration = 0;
  let maxDuration = 0;
  if (handled.length > 0) {
    const totalDuration = handled.reduce((sum, t) => sum + t.processingDurationMinutes, 0);
    avgDuration = Math.round(totalDuration / handled.length);
    maxDuration = Math.max(...handled.map(t => t.processingDurationMinutes));
  }

  const reasonStats = {};
  for (const t of transfers) {
    if (!reasonStats[t.reason]) {
      reasonStats[t.reason] = { count: 0, accepted: 0, rejected: 0, timeout: 0 };
    }
    reasonStats[t.reason].count++;
    if (t.status === TRANSFER_STATUS.ACCEPTED) reasonStats[t.reason].accepted++;
    if (t.status === TRANSFER_STATUS.REJECTED) reasonStats[t.reason].rejected++;
    if (t.status === TRANSFER_STATUS.TIMEOUT) reasonStats[t.reason].timeout++;
  }

  return {
    total,
    pending,
    accepted,
    rejected,
    timeout,
    avgProcessingMinutes: avgDuration,
    maxProcessingMinutes: maxDuration,
    acceptanceRate: total > 0 ? Number(((accepted / total) * 100).toFixed(1)) : 0,
    rejectRate: total > 0 ? Number(((rejected / total) * 100).toFixed(1)) : 0,
    timeoutRate: total > 0 ? Number(((timeout / total) * 100).toFixed(1)) : 0,
    reasonBreakdown: Object.entries(reasonStats).map(([reason, stats]) => ({
      reason,
      count: stats.count,
      accepted: stats.accepted,
      rejected: stats.rejected,
      timeout: stats.timeout,
      acceptanceRate: stats.count > 0 ? Number(((stats.accepted / stats.count) * 100).toFixed(1)) : 0
    })).sort((a, b) => b.count - a.count)
  };
}

function getTimeoutTransferList(filters = {}, page = 1, pageSize = 20) {
  const timeoutMinutes = getConfig('TRANSFER_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.TRANSFER_TIMEOUT_MINUTES;
  const now = new Date();
  
  let all = stores.waveTransfers().findAll();
  
  const pending = all.filter(t => t.status === TRANSFER_STATUS.PENDING);
  const overdue = [];
  for (const t of pending) {
    const pendingMinutes = Math.round((now - new Date(t.transferredAt)) / (1000 * 60));
    if (pendingMinutes > timeoutMinutes) {
      overdue.push({
        ...t,
        pendingMinutes,
        overdueMinutes: pendingMinutes - timeoutMinutes,
        timeoutThreshold: timeoutMinutes
      });
    }
  }

  const alreadyTimeout = all.filter(t => t.status === TRANSFER_STATUS.TIMEOUT).map(t => ({
    ...t,
    pendingMinutes: t.processingDurationMinutes || 0,
    overdueMinutes: (t.processingDurationMinutes || 0) - timeoutMinutes,
    timeoutThreshold: timeoutMinutes
  }));

  let result = [...overdue, ...alreadyTimeout];

  if (filters.transferRole) result = result.filter(t => t.transferRole === filters.transferRole);
  if (filters.newUserId) result = result.filter(t => t.newUserId === filters.newUserId);
  if (filters.operatorId) result = result.filter(t => t.operatorId === filters.operatorId);
  if (filters.waveNo) result = result.filter(t => String(t.waveNo || '').includes(filters.waveNo));

  result.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
  const total = result.length;
  const data = result.slice((page - 1) * pageSize, page * pageSize);
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize), timeoutThreshold: timeoutMinutes };
}

module.exports = {
  canTransferWave,
  initiateTransfer,
  acceptTransfer,
  rejectTransfer,
  hasPendingTransfer,
  getActiveTransfer,
  getPendingTransferForUser,
  getMyTransferList,
  checkAllTransferTimeout,
  getWaveTransferHistory,
  getLatestTransfer,
  getTransferList,
  enrichTransferWithUsers,
  getUserTransferStats,
  getTransferStats,
  getTimeoutTransferList
};
