const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { stores } = require('../models');
const { WAVE_STATUS, DISCREPANCY_LEVEL, CONFIG_DEFAULTS, SUSPENSION_STATUS, TRANSFER_REASONS } = require('../models/constants');
const { runAllChecks, getConfig, checkAllReviewTimeout, checkPackingConfirmationMiss, checkAllSuspensionTimeout } = require('../utils/detector');
const { getWaveSuspensionTimeline, getActiveSuspension, getSuspensionList } = require('../utils/suspension');
const { getWaveTransferHistory, getLatestTransfer, getTransferList, enrichTransferWithUsers, getActiveTransfer, getTransferStats, getTimeoutTransferList } = require('../utils/transfer');

const parsePagination = (req) => ({
  page: Math.max(1, parseInt(req.query.page) || 1),
  pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50))
});

function getUserVisibleWaveIds(user) {
  if (!user || user.role === 'admin') return null;
  const wavesStore = stores.waves();
  const allWaves = wavesStore.findAll();
  if (user.role === 'picker') {
    return allWaves.filter(w => w.pickerId === user.id).map(w => w.id);
  }
  if (user.role === 'checker') {
    return allWaves.filter(w => w.checkerId === user.id).map(w => w.id);
  }
  return [];
}

router.get('/waves', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const { zoneId, waveNo, skuCode, pickerId, status, startDate, endDate, isSuspended } = req.query;
    const wavesStore = stores.waves();
    let all = wavesStore.findAll();
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    if (visibleWaveIds !== null) {
      all = all.filter(w => visibleWaveIds.includes(w.id));
    }
    if (zoneId) all = all.filter(w => w.zoneId === zoneId);
    if (waveNo) all = all.filter(w => String(w.waveNo || '').includes(waveNo));
    if (status) all = all.filter(w => w.status === status);
    if (pickerId) all = all.filter(w => w.pickerId === pickerId);
    if (isSuspended !== undefined) {
      const suspended = isSuspended === 'true';
      all = all.filter(w => w.isSuspended === suspended);
    }
    if (skuCode) {
      all = all.filter(w => (w.items || []).some(i => String(i.skuCode || '').includes(skuCode)));
    }
    if (startDate) {
      const sd = new Date(startDate);
      all = all.filter(w => new Date(w.createdAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      all = all.filter(w => new Date(w.createdAt) <= ed);
    }
    all.sort((a, b) => {
      if (a.isSuspended && !b.isSuspended) return -1;
      if (!a.isSuspended && b.isSuspended) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    const total = all.length;
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    const zonesStore = stores.zones();
    const usersStore = stores.users();
    const suspensionsStore = stores.waveSuspensions();
    data.forEach(w => {
      if (w.zoneId) {
        const z = zonesStore.findById(w.zoneId);
        if (z) w.zone = { id: z.id, zoneCode: z.zoneCode, zoneName: z.zoneName };
      }
      if (w.pickerId) {
        const u = usersStore.findById(w.pickerId);
        if (u) w.picker = { id: u.id, username: u.username, realName: u.realName };
      }
      if (w.checkerId) {
        const u = usersStore.findById(w.checkerId);
        if (u) w.checker = { id: u.id, username: u.username, realName: u.realName };
      }
      if (w.isSuspended && w.currentSuspensionId) {
        const susp = suspensionsStore.findById(w.currentSuspensionId);
        if (susp) {
          w.currentSuspension = {
            id: susp.id,
            reason: susp.reason,
            responsiblePerson: susp.responsiblePerson,
            remark: susp.remark,
            expectedResumeAt: susp.expectedResumeAt,
            suspendedAt: susp.suspendedAt,
            suspendedByName: susp.suspendedByName
          };
        }
      }
      if (w.lastTransferId) {
        const latestTransfer = getLatestTransfer(w.id);
        if (latestTransfer) {
          w.lastTransfer = {
            id: latestTransfer.id,
            transferRole: latestTransfer.transferRole,
            reason: latestTransfer.reason,
            remark: latestTransfer.remark,
            operatorId: latestTransfer.operatorId,
            operatorName: latestTransfer.operatorName,
            originalUserId: latestTransfer.originalUserId,
            originalUserName: latestTransfer.originalUserName,
            newUserId: latestTransfer.newUserId,
            newUserName: latestTransfer.newUserName,
            transferredAt: latestTransfer.transferredAt,
            waveStatusAtTransfer: latestTransfer.waveStatusAtTransfer,
            status: latestTransfer.status,
            handledAt: latestTransfer.handledAt,
            rejectReason: latestTransfer.rejectReason,
            rejectRemark: latestTransfer.rejectRemark,
            processingDurationMinutes: latestTransfer.processingDurationMinutes
          };
          if (latestTransfer.operatorId) {
            const op = usersStore.findById(latestTransfer.operatorId);
            if (op) w.lastTransfer.operatorUser = { id: op.id, username: op.username, realName: op.realName };
          }
          if (latestTransfer.originalUserId) {
            const ou = usersStore.findById(latestTransfer.originalUserId);
            if (ou) w.lastTransfer.originalUser = { id: ou.id, username: ou.username, realName: ou.realName };
          }
          if (latestTransfer.newUserId) {
            const nu = usersStore.findById(latestTransfer.newUserId);
            if (nu) w.lastTransfer.newUser = { id: nu.id, username: nu.username, realName: nu.realName };
          }
        }
      }
      if (w.pendingTransferId) {
        const pendingTransfer = getActiveTransfer(w.id);
        if (pendingTransfer) {
          w.pendingTransfer = {
            id: pendingTransfer.id,
            transferRole: pendingTransfer.transferRole,
            reason: pendingTransfer.reason,
            remark: pendingTransfer.remark,
            operatorId: pendingTransfer.operatorId,
            operatorName: pendingTransfer.operatorName,
            originalUserId: pendingTransfer.originalUserId,
            originalUserName: pendingTransfer.originalUserName,
            newUserId: pendingTransfer.newUserId,
            newUserName: pendingTransfer.newUserName,
            transferredAt: pendingTransfer.transferredAt,
            status: pendingTransfer.status
          };
          if (pendingTransfer.operatorId) {
            const op = usersStore.findById(pendingTransfer.operatorId);
            if (op) w.pendingTransfer.operatorUser = { id: op.id, username: op.username, realName: op.realName };
          }
          if (pendingTransfer.originalUserId) {
            const ou = usersStore.findById(pendingTransfer.originalUserId);
            if (ou) w.pendingTransfer.originalUser = { id: ou.id, username: ou.username, realName: ou.realName };
          }
          if (pendingTransfer.newUserId) {
            const nu = usersStore.findById(pendingTransfer.newUserId);
            if (nu) w.pendingTransfer.newUser = { id: nu.id, username: nu.username, realName: nu.realName };
          }
        }
      }
    });
    res.json({ data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

router.get('/waves/:id', authMiddleware(), (req, res, next) => {
  try {
    const wave = stores.waves().findById(req.params.id);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    if (visibleWaveIds !== null && !visibleWaveIds.includes(wave.id)) {
      return res.status(403).json({ error: '无权查看该波次详情' });
    }
    const zonesStore = stores.zones();
    const usersStore = stores.users();
    const pickingRecords = stores.pickingRecords().find({ waveId: wave.id });
    const checkRecords = stores.checkRecords().find({ waveId: wave.id });
    const suspensionTimeline = getWaveSuspensionTimeline(wave.id);
    const activeSuspension = getActiveSuspension(wave.id);
    if (wave.zoneId) {
      const z = zonesStore.findById(wave.zoneId);
      if (z) wave.zone = { id: z.id, zoneCode: z.zoneCode, zoneName: z.zoneName };
    }
    if (wave.pickerId) {
      const u = usersStore.findById(wave.pickerId);
      if (u) wave.picker = { id: u.id, username: u.username, realName: u.realName };
    }
    if (wave.checkerId) {
      const u = usersStore.findById(wave.checkerId);
      if (u) wave.checker = { id: u.id, username: u.username, realName: u.realName };
    }
    wave.pickingRecords = pickingRecords;
    wave.checkRecords = checkRecords;
    wave.suspensionTimeline = suspensionTimeline;
    wave.activeSuspension = activeSuspension;
    const transferHistory = getWaveTransferHistory(wave.id);
    wave.transferHistory = enrichTransferWithUsers(transferHistory);
    wave.transferCount = transferHistory.length;
    if (transferHistory.length > 0) {
      const latest = transferHistory[transferHistory.length - 1];
      wave.lastTransfer = {
        id: latest.id,
        transferRole: latest.transferRole,
        reason: latest.reason,
        remark: latest.remark,
        operatorId: latest.operatorId,
        operatorName: latest.operatorName,
        originalUserId: latest.originalUserId,
        originalUserName: latest.originalUserName,
        newUserId: latest.newUserId,
        newUserName: latest.newUserName,
        transferredAt: latest.transferredAt,
        waveStatusAtTransfer: latest.waveStatusAtTransfer,
        status: latest.status,
        handledAt: latest.handledAt,
        rejectReason: latest.rejectReason,
        rejectRemark: latest.rejectRemark,
        processingDurationMinutes: latest.processingDurationMinutes
      };
      if (latest.operatorId) {
        const op = usersStore.findById(latest.operatorId);
        if (op) wave.lastTransfer.operatorUser = { id: op.id, username: op.username, realName: op.realName };
      }
      if (latest.originalUserId) {
        const ou = usersStore.findById(latest.originalUserId);
        if (ou) wave.lastTransfer.originalUser = { id: ou.id, username: ou.username, realName: ou.realName };
      }
      if (latest.newUserId) {
        const nu = usersStore.findById(latest.newUserId);
        if (nu) wave.lastTransfer.newUser = { id: nu.id, username: nu.username, realName: nu.realName };
      }
    }
    const pendingTransfer = getActiveTransfer(wave.id);
    if (pendingTransfer) {
      wave.pendingTransfer = {
        id: pendingTransfer.id,
        transferRole: pendingTransfer.transferRole,
        reason: pendingTransfer.reason,
        remark: pendingTransfer.remark,
        operatorId: pendingTransfer.operatorId,
        operatorName: pendingTransfer.operatorName,
        originalUserId: pendingTransfer.originalUserId,
        originalUserName: pendingTransfer.originalUserName,
        newUserId: pendingTransfer.newUserId,
        newUserName: pendingTransfer.newUserName,
        transferredAt: pendingTransfer.transferredAt,
        status: pendingTransfer.status
      };
      if (pendingTransfer.operatorId) {
        const op = usersStore.findById(pendingTransfer.operatorId);
        if (op) wave.pendingTransfer.operatorUser = { id: op.id, username: op.username, realName: op.realName };
      }
      if (pendingTransfer.originalUserId) {
        const ou = usersStore.findById(pendingTransfer.originalUserId);
        if (ou) wave.pendingTransfer.originalUser = { id: ou.id, username: ou.username, realName: ou.realName };
      }
      if (pendingTransfer.newUserId) {
        const nu = usersStore.findById(pendingTransfer.newUserId);
        if (nu) wave.pendingTransfer.newUser = { id: nu.id, username: nu.username, realName: nu.realName };
      }
    }
    res.json({ data: wave });
  } catch (e) { next(e); }
});

router.get('/check-records', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const { waveId, locationId, skuCode, discrepancyLevel, hasDiscrepancy, checkerId, startDate, endDate } = req.query;
    let all = stores.checkRecords().findAll();
    if (waveId) all = all.filter(r => r.waveId === waveId);
    if (locationId) all = all.filter(r => r.locationId === locationId);
    if (skuCode) all = all.filter(r => String(r.skuCode || '').includes(skuCode));
    if (discrepancyLevel) all = all.filter(r => r.discrepancyLevel === discrepancyLevel);
    if (hasDiscrepancy !== undefined) all = all.filter(r => r.hasDiscrepancy === (hasDiscrepancy === 'true'));
    if (checkerId) all = all.filter(r => r.checkerId === checkerId);
    if (startDate) {
      const sd = new Date(startDate);
      all = all.filter(r => new Date(r.checkedAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      all = all.filter(r => new Date(r.checkedAt) <= ed);
    }
    all.sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt));
    const total = all.length;
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    res.json({ data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

router.get('/picking-records', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const { waveId, locationId, skuCode, pickerId, pathDeviation, startDate, endDate } = req.query;
    let all = stores.pickingRecords().findAll();
    if (waveId) all = all.filter(r => r.waveId === waveId);
    if (locationId) all = all.filter(r => r.locationId === locationId || r.scannedLocationId === locationId);
    if (skuCode) all = all.filter(r => String(r.skuCode || '').includes(skuCode));
    if (pickerId) all = all.filter(r => r.pickerId === pickerId);
    if (pathDeviation !== undefined) all = all.filter(r => r.pathDeviation === (pathDeviation === 'true'));
    if (startDate) {
      const sd = new Date(startDate);
      all = all.filter(r => new Date(r.scannedAt || r.createdAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      all = all.filter(r => new Date(r.scannedAt || r.createdAt) <= ed);
    }
    all.sort((a, b) => new Date(b.scannedAt || b.createdAt) - new Date(a.scannedAt || a.createdAt));
    const total = all.length;
    const data = all.slice((page - 1) * pageSize, page * pageSize);
    res.json({ data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

router.get('/stats/discrepancy-locations', authMiddleware(), (req, res, next) => {
  try {
    const { startDate, endDate, top = 20 } = req.query;
    let records = stores.checkRecords().find({ hasDiscrepancy: true });
    if (startDate) {
      const sd = new Date(startDate);
      records = records.filter(r => new Date(r.checkedAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      records = records.filter(r => new Date(r.checkedAt) <= ed);
    }
    const locMap = new Map();
    for (const r of records) {
      const key = r.locationId;
      if (!locMap.has(key)) {
        locMap.set(key, {
          locationId: key,
          locationCode: r.locationCode,
          totalCount: 0,
          qtyDiffCount: 0,
          wrongItemCount: 0,
          highLevelCount: 0,
          unresolvedCount: 0,
          records: []
        });
      }
      const item = locMap.get(key);
      item.totalCount++;
      if (r.qtyDiff !== 0) item.qtyDiffCount++;
      if (r.hasWrongItem) item.wrongItemCount++;
      if (r.discrepancyLevel === DISCREPANCY_LEVEL.HIGH || r.discrepancyLevel === DISCREPANCY_LEVEL.CRITICAL) {
        item.highLevelCount++;
      }
      if (r.hasDiscrepancy && !r.discrepancyResolved) item.unresolvedCount++;
      if (item.records.length < 5) item.records.push({ id: r.id, skuCode: r.skuCode, checkedAt: r.checkedAt, discrepancyLevel: r.discrepancyLevel });
    }
    const list = Array.from(locMap.values()).sort((a, b) => b.totalCount - a.totalCount).slice(0, Number(top));
    const thresholds = getConfig('LOCATION_DISCREPANCY_THRESHOLD') || CONFIG_DEFAULTS.LOCATION_DISCREPANCY_THRESHOLD;
    res.json({
      data: list,
      total: locMap.size,
      threshold: thresholds,
      flagged: list.filter(l => l.totalCount >= thresholds).length
    });
  } catch (e) { next(e); }
});

router.get('/stats/review-timeouts', authMiddleware(), (req, res, next) => {
  try {
    const timeoutMinutes = getConfig('REVIEW_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.REVIEW_TIMEOUT_MINUTES;
    const now = new Date();
    const waves = stores.waves().find({ status: WAVE_STATUS.TO_CHECK });
    const zonesStore = stores.zones();
    const usersStore = stores.users();
    const list = [];
    for (const wave of waves) {
      if (!wave.pickingFinishedAt) continue;
      const waitingMinutes = Math.round((now - new Date(wave.pickingFinishedAt)) / (1000 * 60));
      if (waitingMinutes > timeoutMinutes) {
        const zone = wave.zoneId ? zonesStore.findById(wave.zoneId) : null;
        const picker = wave.pickerId ? usersStore.findById(wave.pickerId) : null;
        list.push({
          waveId: wave.id,
          waveNo: wave.waveNo,
          status: wave.status,
          zone: zone ? { zoneCode: zone.zoneCode, zoneName: zone.zoneName } : null,
          picker: picker ? { username: picker.username, realName: picker.realName } : null,
          pickingFinishedAt: wave.pickingFinishedAt,
          waitingMinutes,
          timeoutThreshold: timeoutMinutes,
          overdueMinutes: waitingMinutes - timeoutMinutes,
          itemCount: (wave.items || []).length,
          totalPlanQty: wave.totalPlanQty
        });
      }
    }
    list.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
    res.json({
      data: list,
      total: list.length,
      timeoutThreshold: timeoutMinutes
    });
  } catch (e) { next(e); }
});

router.get('/stats/wave-efficiency', authMiddleware(), (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    let waves = stores.waves().findAll();
    waves = waves.filter(w => w.pickingStartedAt && (w.pickingFinishedAt || w.closedAt));
    if (startDate) {
      const sd = new Date(startDate);
      waves = waves.filter(w => new Date(w.pickingStartedAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      waves = waves.filter(w => new Date(w.pickingStartedAt) <= ed);
    }
    const buckets = [
      { min: 0, max: 30, label: '<30分钟', count: 0, waveIds: [] },
      { min: 30, max: 60, label: '30-60分钟', count: 0, waveIds: [] },
      { min: 60, max: 120, label: '1-2小时', count: 0, waveIds: [] },
      { min: 120, max: 240, label: '2-4小时', count: 0, waveIds: [] },
      { min: 240, max: Infinity, label: '>4小时', count: 0, waveIds: [] }
    ];
    const details = [];
    let totalMinutes = 0;
    let totalItems = 0;
    for (const w of waves) {
      const start = new Date(w.pickingStartedAt);
      const end = new Date(w.pickingFinishedAt || w.closedAt);
      const minutes = Math.max(0, Math.round((end - start) / (1000 * 60)));
      const itemCount = (w.items || []).length;
      const avgPerItem = itemCount > 0 ? (minutes / itemCount) : 0;
      totalMinutes += minutes;
      totalItems += itemCount;
      const bucket = buckets.find(b => minutes >= b.min && minutes < b.max);
      if (bucket) {
        bucket.count++;
        if (bucket.waveIds.length < 20) bucket.waveIds.push({ waveNo: w.waveNo, minutes, itemCount });
      }
      details.push({
        waveId: w.id,
        waveNo: w.waveNo,
        pickingMinutes: minutes,
        itemCount,
        avgMinutesPerItem: Number(avgPerItem.toFixed(2)),
        status: w.status,
        startedAt: w.pickingStartedAt,
        finishedAt: w.pickingFinishedAt
      });
    }
    details.sort((a, b) => b.pickingMinutes - a.pickingMinutes);
    const totalWaves = waves.length;
    res.json({
      data: {
        buckets: buckets.map(b => ({ label: b.label, count: b.count, ratio: totalWaves > 0 ? Number((b.count / totalWaves * 100).toFixed(1)) : 0, samples: b.waveIds })),
        summary: {
          totalWaves,
          totalMinutes,
          avgMinutesPerWave: totalWaves > 0 ? Number((totalMinutes / totalWaves).toFixed(2)) : 0,
          totalItems,
          avgMinutesPerItem: totalItems > 0 ? Number((totalMinutes / totalItems).toFixed(2)) : 0
        },
        details: details.slice(0, 100)
      }
    });
  } catch (e) { next(e); }
});

router.get('/wave-suspensions', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    const filters = {
      waveId: req.query.waveId,
      waveNo: req.query.waveNo,
      status: req.query.status,
      reason: req.query.reason,
      responsiblePerson: req.query.responsiblePerson,
      suspendedBy: req.query.suspendedBy,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    };
    if (visibleWaveIds !== null) {
      filters.waveIds = visibleWaveIds;
    }
    const result = getSuspensionList(filters, page, pageSize);
    const usersStore = stores.users();
    result.data.forEach(s => {
      if (s.suspendedBy) {
        const u = usersStore.findById(s.suspendedBy);
        if (u) s.suspendedByUser = { id: u.id, username: u.username, realName: u.realName };
      }
      if (s.resumedBy) {
        const u = usersStore.findById(s.resumedBy);
        if (u) s.resumedByUser = { id: u.id, username: u.username, realName: u.realName };
      }
    });
    res.json({ data: result.data, total: result.total, page, pageSize, totalPages: result.totalPages });
  } catch (e) { next(e); }
});

router.get('/waves/:id/suspension-timeline', authMiddleware(), (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    if (visibleWaveIds !== null && !visibleWaveIds.includes(waveId)) {
      return res.status(403).json({ error: '无权查看该波次的挂起记录' });
    }
    const timeline = getWaveSuspensionTimeline(waveId);
    const activeSuspension = getActiveSuspension(waveId);
    res.json({ data: { timeline, activeSuspension } });
  } catch (e) { next(e); }
});

router.get('/stats/suspension-timeouts', authMiddleware(), (req, res, next) => {
  try {
    const timeoutMinutes = getConfig('SUSPENSION_TIMEOUT_MINUTES') || CONFIG_DEFAULTS.SUSPENSION_TIMEOUT_MINUTES;
    const now = new Date();
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    const suspensions = stores.waveSuspensions().find({ 
      status: { $in: [SUSPENSION_STATUS.ACTIVE, SUSPENSION_STATUS.TIMEOUT] } 
    });
    const filteredSuspensions = visibleWaveIds !== null
      ? suspensions.filter(s => visibleWaveIds.includes(s.waveId))
      : suspensions;
    const zonesStore = stores.zones();
    const usersStore = stores.users();
    const list = [];
    for (const s of filteredSuspensions) {
      const suspendedMinutes = Math.round((now - new Date(s.suspendedAt)) / (1000 * 60));
      if (suspendedMinutes > timeoutMinutes || s.status === SUSPENSION_STATUS.TIMEOUT) {
        const wave = stores.waves().findById(s.waveId);
        const zone = wave && wave.zoneId ? zonesStore.findById(wave.zoneId) : null;
        const picker = wave && wave.pickerId ? usersStore.findById(wave.pickerId) : null;
        const suspendedByUser = s.suspendedBy ? usersStore.findById(s.suspendedBy) : null;
        list.push({
          suspensionId: s.id,
          waveId: s.waveId,
          waveNo: s.waveNo,
          waveStatus: wave ? wave.status : null,
          suspensionStatus: s.status,
          reason: s.reason,
          responsiblePerson: s.responsiblePerson,
          remark: s.remark,
          expectedResumeAt: s.expectedResumeAt,
          suspendedAt: s.suspendedAt,
          timeoutAt: s.timeoutAt || null,
          suspendedByName: s.suspendedByName,
          suspendedByUser: suspendedByUser ? { id: suspendedByUser.id, username: suspendedByUser.username, realName: suspendedByUser.realName } : null,
          suspendedMinutes,
          timeoutThreshold: timeoutMinutes,
          overdueMinutes: Math.max(0, suspendedMinutes - timeoutMinutes),
          zone: zone ? { zoneCode: zone.zoneCode, zoneName: zone.zoneName } : null,
          picker: picker ? { username: picker.username, realName: picker.realName } : null
        });
      }
    }
    list.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
    res.json({
      data: list,
      total: list.length,
      timeoutThreshold: timeoutMinutes
    });
  } catch (e) { next(e); }
});

router.get('/stats/suspension-summary', authMiddleware(), (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    let suspensions = stores.waveSuspensions().findAll();
    if (visibleWaveIds !== null) {
      suspensions = suspensions.filter(s => visibleWaveIds.includes(s.waveId));
    }
    if (startDate) {
      const sd = new Date(startDate);
      suspensions = suspensions.filter(s => new Date(s.suspendedAt) >= sd);
    }
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      suspensions = suspensions.filter(s => new Date(s.suspendedAt) <= ed);
    }
    const activeCount = suspensions.filter(s => s.status === SUSPENSION_STATUS.ACTIVE).length;
    const timeoutCount = suspensions.filter(s => s.status === SUSPENSION_STATUS.TIMEOUT).length;
    const resumedCount = suspensions.filter(s => s.status === SUSPENSION_STATUS.RESUMED).length;
    const totalCount = suspensions.length;
    const reasonStats = {};
    for (const s of suspensions) {
      if (!reasonStats[s.reason]) {
        reasonStats[s.reason] = { count: 0, totalDuration: 0, activeCount: 0, timeoutCount: 0, resumedCount: 0 };
      }
      reasonStats[s.reason].count++;
      if (s.status === SUSPENSION_STATUS.ACTIVE) reasonStats[s.reason].activeCount++;
      if (s.status === SUSPENSION_STATUS.TIMEOUT) reasonStats[s.reason].timeoutCount++;
      if (s.status === SUSPENSION_STATUS.RESUMED) reasonStats[s.reason].resumedCount++;
      if (s.suspensionDurationMinutes) {
        reasonStats[s.reason].totalDuration += s.suspensionDurationMinutes;
      }
    }
    const totalDuration = suspensions.reduce((sum, s) => sum + (s.suspensionDurationMinutes || 0), 0);
    const avgDuration = totalCount > 0 ? Math.round(totalDuration / totalCount) : 0;
    const wavesStore = stores.waves();
    const activeSuspendedWaves = wavesStore.count({ isSuspended: true });
    res.json({
      data: {
        totalSuspensions: totalCount,
        activeSuspensions: activeCount,
        timeoutSuspensions: timeoutCount,
        resumedSuspensions: resumedCount,
        activeSuspendedWaves,
        totalDurationMinutes: totalDuration,
        avgDurationMinutes: avgDuration,
        reasonBreakdown: Object.entries(reasonStats).map(([reason, stats]) => ({
          reason,
          count: stats.count,
          activeCount: stats.activeCount,
          timeoutCount: stats.timeoutCount,
          resumedCount: stats.resumedCount,
          totalDurationMinutes: stats.totalDuration,
          avgDurationMinutes: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0
        })).sort((a, b) => b.count - a.count)
      }
    });
  } catch (e) { next(e); }
});

router.get('/wave-transfers', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    const filters = {
      waveId: req.query.waveId,
      waveNo: req.query.waveNo,
      transferRole: req.query.transferRole,
      reason: req.query.reason,
      operatorId: req.query.operatorId,
      originalUserId: req.query.originalUserId,
      newUserId: req.query.newUserId,
      status: req.query.status,
      isTimeout: req.query.isTimeout,
      waveStatusAtTransfer: req.query.waveStatusAtTransfer,
      isSuspendedAtTransfer: req.query.isSuspendedAtTransfer,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    };
    if (req.user.role !== 'admin') {
      filters.userId = req.user.id;
    }
    if (visibleWaveIds !== null) {
      filters.waveIds = visibleWaveIds;
    }
    const result = getTransferList(filters, page, pageSize);
    result.data = enrichTransferWithUsers(result.data);
    res.json({ data: result.data, total: result.total, page, pageSize, totalPages: result.totalPages });
  } catch (e) { next(e); }
});

router.get('/wave-transfers/timeouts', authMiddleware(), (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    const filters = {
      transferRole: req.query.transferRole,
      newUserId: req.query.newUserId,
      operatorId: req.query.operatorId,
      waveNo: req.query.waveNo
    };
    if (req.user.role !== 'admin') {
      filters.newUserId = req.user.id;
    }
    const result = getTimeoutTransferList(filters, page, pageSize);
    if (visibleWaveIds !== null) {
      const filtered = result.data.filter(t => visibleWaveIds.includes(t.waveId));
      result.data = filtered;
      result.total = filtered.length;
    }
    result.data = enrichTransferWithUsers(result.data);
    res.json({ 
      data: result.data, 
      total: result.total, 
      page, 
      pageSize, 
      totalPages: result.totalPages,
      timeoutThreshold: result.timeoutThreshold
    });
  } catch (e) { next(e); }
});

router.get('/wave-transfers/stats', authMiddleware(), (req, res, next) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      transferRole: req.query.transferRole,
      operatorId: req.query.operatorId
    };
    if (req.user.role !== 'admin') {
      filters.operatorId = req.user.id;
    }
    const stats = getTransferStats(filters);
    res.json({ data: stats });
  } catch (e) { next(e); }
});

router.get('/waves/:id/transfer-history', authMiddleware(), (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const visibleWaveIds = getUserVisibleWaveIds(req.user);
    if (visibleWaveIds !== null && !visibleWaveIds.includes(waveId)) {
      return res.status(403).json({ error: '无权查看该波次的转派历史' });
    }
    const history = getWaveTransferHistory(waveId);
    const enriched = enrichTransferWithUsers(history);
    res.json({ data: enriched, total: enriched.length });
  } catch (e) { next(e); }
});

router.get('/transfer-reasons', authMiddleware(), (req, res, next) => {
  try {
    res.json({ data: TRANSFER_REASONS });
  } catch (e) { next(e); }
});

router.get('/health', (req, res) => {
  try {
    const alerts = runAllChecks();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      port: 8145,
      entities: {
        zones: stores.zones().count(),
        locations: stores.locations().count(),
        skus: stores.skus().count(),
        waves: stores.waves().count(),
        users: stores.users().count(),
        alerts: stores.alerts().count({ resolved: false }),
        waveSuspensions: {
          active: stores.waveSuspensions().count({ status: SUSPENSION_STATUS.ACTIVE }),
          timeout: stores.waveSuspensions().count({ status: SUSPENSION_STATUS.TIMEOUT }),
          total: stores.waveSuspensions().count()
        },
        waveTransfers: {
          total: stores.waveTransfers().count()
        }
      },
      pendingChecks: alerts
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

module.exports = router;
