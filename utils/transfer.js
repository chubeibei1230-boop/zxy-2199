const { stores, newId } = require('../models');
const {
  WAVE_STATUS,
  TRANSFER_REASONS,
  TRANSFERABLE_ROLES,
  TRANSFERABLE_STATUSES,
  ROLES
} = require('../models/constants');

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
  return { allowed: true };
}

function transferWave(waveId, operatorId, operatorName, targetUserId, targetRole, reason, remark) {
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
    transferredAt: new Date().toISOString(),
    waveStatusAtTransfer: wave.status
  });

  const updateData = {};
  updateData[targetField] = targetUserId;
  updateData.transferCount = (wave.transferCount || 0) + 1;
  updateData.lastTransferId = transferId;
  updateData.lastTransferAt = transferRecord.transferredAt;
  const updatedWave = wavesStore.update(waveId, updateData);

  return { wave: updatedWave, transfer: transferRecord };
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
  if (filters.waveStatusAtTransfer) {
    all = all.filter(t => t.waveStatusAtTransfer === filters.waveStatusAtTransfer);
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

  return {
    totalTransfers: transfers.length,
    asOriginalCount: asOriginal,
    asNewCount: asNew
  };
}

module.exports = {
  canTransferWave,
  transferWave,
  getWaveTransferHistory,
  getLatestTransfer,
  getTransferList,
  enrichTransferWithUsers,
  getUserTransferStats
};
