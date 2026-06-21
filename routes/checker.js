const express = require('express');
const router = express.Router();
const { requireChecker, requireAdmin, validateBody, authMiddleware } = require('../middleware/auth');
const { stores, newId } = require('../models');
const { WAVE_STATUS, WRONG_ITEM_REASONS, PACKING_SUGGESTIONS, DISCREPANCY_LEVEL, SUSPENSION_REASONS } = require('../models/constants');
const { checkLocationDiscrepancyCluster, getConfig } = require('../utils/detector');
const { suspendWave, resumeWave, canSuspendWave, canResumeWave, getActiveSuspension, getWaveSuspensionTimeline } = require('../utils/suspension');
const { acceptTransfer, rejectTransfer, getPendingTransferForUser, getMyTransferList, enrichTransferWithUsers, getUserTransferStats } = require('../utils/transfer');
const { TRANSFER_REJECT_REASONS, ROLES } = require('../models/constants');

function calcDiscrepancyLevel(diffRatio) {
  const abs = Math.abs(diffRatio);
  if (abs === 0) return null;
  if (abs < 0.1) return DISCREPANCY_LEVEL.LOW;
  if (abs < 0.3) return DISCREPANCY_LEVEL.MEDIUM;
  if (abs < 0.5) return DISCREPANCY_LEVEL.HIGH;
  return DISCREPANCY_LEVEL.CRITICAL;
}

function requireWaveChecker(wave, userId) {
  if (!wave) {
    return { allowed: false, reason: '波次不存在' };
  }
  if (!wave.checkerId) {
    return { allowed: true };
  }
  if (wave.checkerId !== userId) {
    return { allowed: false, reason: '该波次已转派给其他复核员，您无权操作' };
  }
  return { allowed: true };
}

router.post('/waves/:id/start-checking', requireChecker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const checkerId = req.user.id;
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法开始复核，请先恢复波次' });
    }
    if (wave.status !== WAVE_STATUS.TO_CHECK && wave.status !== WAVE_STATUS.DISCREPANCY) {
      return res.status(400).json({ error: `当前波次状态为 ${wave.status}，只能从待复核或差异处理中开始` });
    }
    const ratio = getConfig('REVIEW_RATIO') || 1.0;
    const items = [...wave.items];
    const itemCount = items.length;
    const sampleSize = Math.max(1, Math.ceil(itemCount * ratio));
    
    const shuffled = items.sort(() => Math.random() - 0.5);
    const sampledItems = shuffled.slice(0, sampleSize);
    const sampledItemIds = sampledItems.map(i => i.pickItemId);
    
    const updated = wavesStore.update(waveId, {
      status: wave.status === WAVE_STATUS.TO_CHECK ? WAVE_STATUS.TO_CHECK : WAVE_STATUS.DISCREPANCY,
      checkerId: wave.checkerId || checkerId,
      checkingStartedAt: wave.checkingStartedAt || new Date().toISOString(),
      reviewSampleSize: sampleSize,
      reviewSampledItemIds: sampledItemIds,
      reviewRatio: ratio
    });
    res.json({ data: updated, sampleSize, totalItems: itemCount, ratio, sampledItemIds });
  } catch (e) { next(e); }
});

router.post('/check-records', requireChecker, validateBody({
  waveId: { required: true, minLength: 1 },
  pickItemId: { required: true, minLength: 1 },
  checkedQty: { required: true, type: 'integer', min: 0 }
}), (req, res, next) => {
  try {
    const checkerId = req.user.id;
    const { waveId, pickItemId, checkedQty, wrongItemSku = null, wrongItemReason = '',
            packingSuggestion = '', remark = '', hasWrongItem = false } = req.body;
    const wavesStore = stores.waves();
    const checkRecordsStore = stores.checkRecords();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法提交复核记录，请先恢复波次' });
    }
    if (wave.status !== WAVE_STATUS.TO_CHECK && wave.status !== WAVE_STATUS.DISCREPANCY) {
      return res.status(400).json({ error: '波次不在可复核状态' });
    }
    
    const existing = checkRecordsStore.findOne({ waveId, pickItemId });
    if (existing) {
      return res.status(409).json({ 
        error: '该拣货明细已复核，请勿重复提交',
        existingRecordId: existing.id 
      });
    }
    
    const sampledIds = wave.reviewSampledItemIds || wave.items.map(i => i.pickItemId);
    if (!sampledIds.includes(pickItemId)) {
      return res.status(400).json({ 
        error: '该拣货明细不在抽检范围内，无需复核',
        sampledItemIds: sampledIds
      });
    }
    
    const item = wave.items.find(i => i.pickItemId === pickItemId);
    if (!item) return res.status(404).json({ error: '拣货明细不存在' });
    if (hasWrongItem && !wrongItemReason) {
      return res.status(400).json({ error: '存在错品时必须填写错品原因' });
    }
    if (wrongItemReason && !WRONG_ITEM_REASONS.includes(wrongItemReason) && wrongItemReason !== '其他') {
      return res.status(400).json({ error: `错品原因必须是: ${WRONG_ITEM_REASONS.join(', ')}` });
    }
    if (packingSuggestion && !PACKING_SUGGESTIONS.includes(packingSuggestion) && packingSuggestion !== '其他') {
      return res.status(400).json({ error: `包装建议必须是: ${PACKING_SUGGESTIONS.join(', ')}` });
    }
    const qtyDiff = checkedQty - (item.actualQty ?? 0);
    const diffRatio = item.planQty > 0 ? qtyDiff / item.planQty : 0;
    const hasDiscrepancy = qtyDiff !== 0 || hasWrongItem;
    const discrepancyLevel = hasDiscrepancy
      ? (qtyDiff !== 0 ? calcDiscrepancyLevel(diffRatio) : DISCREPANCY_LEVEL.MEDIUM)
      : null;
    const record = checkRecordsStore.create({
      id: newId(),
      waveId,
      waveNo: wave.waveNo,
      pickItemId,
      skuId: item.skuId,
      skuCode: item.skuCode,
      locationId: item.locationId,
      locationCode: item.locationCode,
      checkerId: req.user.id,
      planQty: item.planQty,
      pickedQty: item.actualQty ?? 0,
      checkedQty,
      qtyDiff,
      diffRatio,
      hasWrongItem,
      wrongItemSku,
      wrongItemReason,
      packingSuggestion,
      hasDiscrepancy,
      discrepancyLevel,
      remark,
      checkedAt: new Date().toISOString(),
      discrepancyResolved: !hasDiscrepancy,
      packingConfirmed: false
    });
    if (hasDiscrepancy) {
      checkLocationDiscrepancyCluster(item.locationId);
      wavesStore.update(waveId, { status: WAVE_STATUS.DISCREPANCY });
    } else {
      const allChecks = checkRecordsStore.find({ waveId });
      const sampledNeedCheck = wave.reviewSampledItemIds || wave.items.map(i => i.pickItemId);
      const completedChecks = allChecks.filter(c => sampledNeedCheck.includes(c.pickItemId));
      const allCompleted = completedChecks.length >= sampledNeedCheck.length;
      const allPass = allChecks.every(c => !c.hasDiscrepancy || c.discrepancyResolved);
      if (allCompleted && allPass && wave.status === WAVE_STATUS.TO_CHECK) {
        wavesStore.update(waveId, { status: WAVE_STATUS.TO_PACK });
      }
    }
    res.json({ data: record });
  } catch (e) { next(e); }
});

router.put('/check-records/:id', requireChecker, (req, res, next) => {
  try {
    const checkerId = req.user.id;
    const rec = stores.checkRecords().findById(req.params.id);
    if (!rec) return res.status(404).json({ error: '复核记录不存在' });
    const wave = stores.waves().findById(rec.waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法修改复核记录，请先恢复波次' });
    }
    const updated = stores.checkRecords().update(req.params.id, req.body);
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post('/check-records/:id/resolve-discrepancy', requireChecker, validateBody({
  resolution: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const checkerId = req.user.id;
    const { resolution, resolverRemark = '' } = req.body;
    const store = stores.checkRecords();
    const rec = store.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: '复核记录不存在' });
    const waveStore = stores.waves();
    const wave = waveStore.findById(rec.waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法处理差异，请先恢复波次' });
    }
    if (!rec.hasDiscrepancy) return res.status(400).json({ error: '该记录无差异' });
    const updated = store.update(rec.id, {
      discrepancyResolved: true,
      discrepancyResolution: resolution,
      resolverRemark,
      resolverId: req.user.id,
      resolvedAt: new Date().toISOString()
    });
    const waveChecks = store.find({ waveId: rec.waveId });
    const allResolved = waveChecks.every(c => !c.hasDiscrepancy || c.discrepancyResolved);
    if (allResolved && wave && wave.status === WAVE_STATUS.DISCREPANCY) {
      waveStore.update(rec.waveId, { status: WAVE_STATUS.TO_PACK });
    }
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post('/check-records/:id/confirm-packing', requireChecker, (req, res, next) => {
  try {
    const checkerId = req.user.id;
    const { packageNo = '', packageWeight = null, packageRemark = '' } = req.body;
    const store = stores.checkRecords();
    const rec = store.findById(req.params.id);
    if (!rec) return res.status(404).json({ error: '复核记录不存在' });
    const wave = stores.waves().findById(rec.waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法进行包装确认，请先恢复波次' });
    }
    if (rec.hasDiscrepancy && !rec.discrepancyResolved) {
      return res.status(400).json({ error: '存在未解决的差异，无法进行包装确认' });
    }
    const updated = store.update(rec.id, {
      packingConfirmed: true,
      packageNo,
      packageWeight,
      packageRemark,
      packingConfirmedAt: new Date().toISOString(),
      packingConfirmedBy: req.user.id
    });
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post('/waves/:id/final-confirm', requireChecker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const checkerId = req.user.id;
    const wavesStore = stores.waves();
    const wave = wavesStore.findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const checkerAuth = requireWaveChecker(wave, checkerId);
    if (!checkerAuth.allowed) return res.status(403).json({ error: checkerAuth.reason });
    if (wave.isSuspended) {
      return res.status(400).json({ error: '波次已挂起，无法最终确认，请先恢复波次' });
    }
    if (wave.status !== WAVE_STATUS.TO_PACK) {
      return res.status(400).json({ error: `当前状态为 ${wave.status}，只能从可包装状态最终确认` });
    }
    const checks = stores.checkRecords().find({ waveId });
    const itemsNeedCheck = wave.reviewSampledItemIds || wave.items.map(i => i.pickItemId);
    const pendingDiscrepancies = checks.filter(c => c.hasDiscrepancy && !c.discrepancyResolved);
    if (pendingDiscrepancies.length > 0) {
      return res.status(400).json({
        error: `有 ${pendingDiscrepancies.length} 条差异未解决`,
        pending: pendingDiscrepancies.map(c => ({ id: c.id, skuCode: c.skuCode, locationCode: c.locationCode }))
      });
    }
    const relatedChecks = checks.filter(c => itemsNeedCheck.includes(c.pickItemId));
    const unconfirmedPacking = relatedChecks.filter(c => !c.packingConfirmed);
    if (unconfirmedPacking.length > 0) {
      return res.status(400).json({
        error: `有 ${unconfirmedPacking.length} 条记录未完成包装确认`,
        unconfirmed: unconfirmedPacking.map(c => ({ id: c.id, skuCode: c.skuCode, locationCode: c.locationCode }))
      });
    }
    const updated = wavesStore.update(waveId, {
      status: WAVE_STATUS.CLOSED,
      checkingFinishedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      finalConfirmedBy: req.user.id
    });
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.get('/waves/my-checking', requireChecker, (req, res, next) => {
  try {
    const waves = stores.waves().find({
      status: { $in: [WAVE_STATUS.TO_CHECK, WAVE_STATUS.DISCREPANCY, WAVE_STATUS.TO_PACK] }
    });
    const filtered = waves.filter(w => !w.checkerId || w.checkerId === req.user.id);
    res.json({ data: filtered, total: filtered.length });
  } catch (e) { next(e); }
});

router.get('/check-records/wave/:waveId', authMiddleware(), (req, res, next) => {
  try {
    const records = stores.checkRecords().find({ waveId: req.params.waveId });
    res.json({ data: records, total: records.length });
  } catch (e) { next(e); }
});

router.post('/waves/:id/suspend', requireChecker, validateBody({
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

router.post('/waves/:id/resume', requireChecker, (req, res, next) => {
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

router.get('/waves/:id/suspension-timeline', requireChecker, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    if (wave.checkerId && wave.checkerId !== req.user.id) {
      return res.status(403).json({ error: '只能查看自己负责的波次挂起记录' });
    }
    const timeline = getWaveSuspensionTimeline(waveId);
    const activeSuspension = getActiveSuspension(waveId);
    res.json({ data: { timeline, activeSuspension } });
  } catch (e) { next(e); }
});

router.get('/suspension-reasons', requireChecker, (req, res, next) => {
  try {
    res.json({ data: SUSPENSION_REASONS });
  } catch (e) { next(e); }
});

router.get('/transfers/pending', requireChecker, (req, res, next) => {
  try {
    const pending = getPendingTransferForUser(req.user.id, ROLES.CHECKER);
    const enriched = enrichTransferWithUsers(pending);
    res.json({ data: enriched, total: enriched.length });
  } catch (e) { next(e); }
});

router.get('/transfers/my', requireChecker, (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const filters = {
      status: req.query.status,
      reason: req.query.reason,
      waveNo: req.query.waveNo,
      type: req.query.type,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    };
    const result = getMyTransferList(req.user.id, ROLES.CHECKER, filters, page, pageSize);
    result.data = enrichTransferWithUsers(result.data);
    res.json({ data: result.data, total: result.total, page, pageSize, totalPages: result.totalPages });
  } catch (e) { next(e); }
});

router.post('/transfers/:id/accept', requireChecker, (req, res, next) => {
  try {
    const transferId = req.params.id;
    const result = acceptTransfer(
      transferId,
      req.user.id,
      req.user.realName || req.user.username
    );
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.post('/transfers/:id/reject', requireChecker, validateBody({
  rejectReason: { required: true, minLength: 1 },
  rejectRemark: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const transferId = req.params.id;
    const { rejectReason, rejectRemark } = req.body;
    const result = rejectTransfer(
      transferId,
      req.user.id,
      req.user.realName || req.user.username,
      rejectReason,
      rejectRemark
    );
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.get('/transfers/stats', requireChecker, (req, res, next) => {
  try {
    const stats = getUserTransferStats(req.user.id, req.query.startDate, req.query.endDate);
    res.json({ data: stats });
  } catch (e) { next(e); }
});

router.get('/transfer-reject-reasons', requireChecker, (req, res, next) => {
  try {
    res.json({ data: TRANSFER_REJECT_REASONS });
  } catch (e) { next(e); }
});

module.exports = router;
