const express = require('express');
const router = express.Router();
const { requireAdmin, validateBody } = require('../middleware/auth');
const { stores, newId } = require('../models');
const { getConfig, setConfig, resolveAlert } = require('../utils/detector');
const { suspendWave, resumeWave, getSuspensionList, getActiveSuspension, getWaveSuspensionTimeline } = require('../utils/suspension');
const { transferWave, canTransferWave, getTransferList, enrichTransferWithUsers, getWaveTransferHistory, getLatestTransfer } = require('../utils/transfer');
const { ROLES, CONFIG_DEFAULTS, SUSPENSION_REASONS, SUSPENSION_STATUS, TRANSFER_REASONS } = require('../models/constants');

const parsePagination = (req) => ({
  page: Math.max(1, parseInt(req.query.page) || 1),
  pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
});

router.post('/zones', requireAdmin, validateBody({
  zoneCode: { required: true, minLength: 1 },
  zoneName: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const { zoneCode, zoneName, description = '', managerId = null } = req.body;
    const zonesStore = stores.zones();
    if (zonesStore.findOne({ zoneCode })) {
      return res.status(409).json({ error: '仓区编码已存在' });
    }
    const zone = zonesStore.create({
      id: newId(),
      zoneCode, zoneName, description, managerId,
      active: true
    });
    res.json({ data: zone });
  } catch (e) { next(e); }
});

router.get('/zones', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.zoneCode) filter.zoneCode = { $regex: req.query.zoneCode };
    if (req.query.zoneName) filter.zoneName = { $regex: req.query.zoneName };
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const result = stores.zones().paginate(filter, page, pageSize, 'createdAt', 'desc');
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.put('/zones/:id', requireAdmin, (req, res, next) => {
  try {
    const zone = stores.zones().update(req.params.id, req.body);
    res.json({ data: zone });
  } catch (e) { next(e); }
});

router.delete('/zones/:id', requireAdmin, (req, res, next) => {
  try {
    stores.zones().delete(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/locations', requireAdmin, validateBody({
  locationCode: { required: true, minLength: 1 },
  zoneId: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const { locationCode, zoneId, row, col, level, capacity, description = '' } = req.body;
    const zonesStore = stores.zones();
    if (!zonesStore.findById(zoneId)) return res.status(404).json({ error: '所属仓区不存在' });
    const locStore = stores.locations();
    if (locStore.findOne({ locationCode })) return res.status(409).json({ error: '货位编码已存在' });
    const loc = locStore.create({
      id: newId(),
      locationCode, zoneId,
      row: row || null, col: col || null, level: level || null,
      capacity: capacity || null,
      description,
      active: true
    });
    res.json({ data: loc });
  } catch (e) { next(e); }
});

router.get('/locations', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.locationCode) filter.locationCode = { $regex: req.query.locationCode };
    if (req.query.zoneId) filter.zoneId = req.query.zoneId;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const result = stores.locations().paginate(filter, page, pageSize, 'locationCode', 'asc');
    const zonesStore = stores.zones();
    result.data.forEach(l => {
      const zone = zonesStore.findById(l.zoneId);
      if (zone) l.zone = { id: zone.id, zoneCode: zone.zoneCode, zoneName: zone.zoneName };
    });
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.put('/locations/:id', requireAdmin, (req, res, next) => {
  try {
    const loc = stores.locations().update(req.params.id, req.body);
    res.json({ data: loc });
  } catch (e) { next(e); }
});

router.delete('/locations/:id', requireAdmin, (req, res, next) => {
  try {
    stores.locations().delete(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/skus', requireAdmin, validateBody({
  skuCode: { required: true, minLength: 1 },
  skuName: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const { skuCode, skuName, barcode, category, unit, defaultLocationId, description = '' } = req.body;
    const skuStore = stores.skus();
    if (skuStore.findOne({ skuCode })) return res.status(409).json({ error: 'SKU编码已存在' });
    const sku = skuStore.create({
      id: newId(),
      skuCode, skuName,
      barcode: barcode || null,
      category: category || null,
      unit: unit || '件',
      defaultLocationId: defaultLocationId || null,
      description,
      active: true
    });
    res.json({ data: sku });
  } catch (e) { next(e); }
});

router.get('/skus', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.skuCode) filter.skuCode = { $regex: req.query.skuCode };
    if (req.query.skuName) filter.skuName = { $regex: req.query.skuName };
    if (req.query.barcode) filter.barcode = { $regex: req.query.barcode };
    if (req.query.category) filter.category = { $regex: req.query.category };
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const result = stores.skus().paginate(filter, page, pageSize, 'skuCode', 'asc');
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.put('/skus/:id', requireAdmin, (req, res, next) => {
  try {
    const sku = stores.skus().update(req.params.id, req.body);
    res.json({ data: sku });
  } catch (e) { next(e); }
});

router.delete('/skus/:id', requireAdmin, (req, res, next) => {
  try {
    stores.skus().delete(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/wave-rules', requireAdmin, validateBody({
  ruleName: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const { ruleName, zoneIds = [], priority = 5, maxSkus = 50, maxQty = 500,
            autoMerge = false, scheduleTime = null, description = '' } = req.body;
    const rule = stores.waveRules().create({
      id: newId(),
      ruleName, zoneIds, priority, maxSkus, maxQty,
      autoMerge, scheduleTime, description,
      active: true
    });
    res.json({ data: rule });
  } catch (e) { next(e); }
});

router.get('/wave-rules', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.ruleName) filter.ruleName = { $regex: req.query.ruleName };
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const result = stores.waveRules().paginate(filter, page, pageSize, 'priority', 'asc');
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.put('/wave-rules/:id', requireAdmin, (req, res, next) => {
  try {
    const rule = stores.waveRules().update(req.params.id, req.body);
    res.json({ data: rule });
  } catch (e) { next(e); }
});

router.delete('/wave-rules/:id', requireAdmin, (req, res, next) => {
  try {
    stores.waveRules().delete(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post('/users', requireAdmin, validateBody({
  username: { required: true, minLength: 1 },
  role: { required: true, enum: Object.values(ROLES) }
}), (req, res, next) => {
  try {
    const { username, role, realName = '', phone = '', email = '' } = req.body;
    const usersStore = stores.users();
    if (usersStore.findOne({ username })) return res.status(409).json({ error: '用户名已存在' });
    const user = usersStore.create({
      id: newId(),
      username, role, realName, phone, email,
      active: true
    });
    res.json({ data: user });
  } catch (e) { next(e); }
});

router.get('/users', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.username) filter.username = { $regex: req.query.username };
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const result = stores.users().paginate(filter, page, pageSize, 'createdAt', 'desc');
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.put('/users/:id', requireAdmin, (req, res, next) => {
  try {
    const user = stores.users().update(req.params.id, req.body);
    res.json({ data: user });
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireAdmin, (req, res, next) => {
  try {
    stores.users().delete(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.get('/config/review-ratio', requireAdmin, (req, res, next) => {
  try {
    const value = getConfig('REVIEW_RATIO');
    res.json({ data: { key: 'REVIEW_RATIO', value: value ?? CONFIG_DEFAULTS.REVIEW_RATIO } });
  } catch (e) { next(e); }
});

router.put('/config/review-ratio', requireAdmin, validateBody({
  value: { required: true, type: 'number', min: 0, max: 1 }
}), (req, res, next) => {
  try {
    const cfg = setConfig('REVIEW_RATIO', req.body.value);
    res.json({ data: cfg });
  } catch (e) { next(e); }
});

router.get('/config/thresholds', requireAdmin, (req, res, next) => {
  try {
    res.json({
      data: {
        PATH_DEVIATION_THRESHOLD: getConfig('PATH_DEVIATION_THRESHOLD'),
        LOCATION_DISCREPANCY_THRESHOLD: getConfig('LOCATION_DISCREPANCY_THRESHOLD'),
        REVIEW_TIMEOUT_MINUTES: getConfig('REVIEW_TIMEOUT_MINUTES')
      }
    });
  } catch (e) { next(e); }
});

router.put('/config/thresholds', requireAdmin, (req, res, next) => {
  try {
    const result = {};
    const keys = ['PATH_DEVIATION_THRESHOLD', 'LOCATION_DISCREPANCY_THRESHOLD', 'REVIEW_TIMEOUT_MINUTES'];
    for (const k of keys) {
      if (req.body[k] !== undefined) {
        result[k] = setConfig(k, req.body[k]);
      }
    }
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.get('/alerts', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.resolved !== undefined) filter.resolved = req.query.resolved === 'true';
    if (req.query.level) filter.level = req.query.level;
    const result = stores.alerts().paginate(filter, page, pageSize, 'lastTriggeredAt', 'desc');
    res.json({ data: result.data, total: result.total, page, pageSize });
  } catch (e) { next(e); }
});

router.post('/alerts/:id/resolve', requireAdmin, (req, res, next) => {
  try {
    const alert = resolveAlert(req.params.id);
    res.json({ data: alert });
  } catch (e) { next(e); }
});

router.post('/waves/:id/suspend', requireAdmin, validateBody({
  reason: { required: true, minLength: 1 },
  responsiblePerson: { required: true, minLength: 1 },
  remark: { required: true, minLength: 1 },
  expectedResumeAt: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const waveId = req.params.id;
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

router.post('/waves/:id/resume', requireAdmin, (req, res, next) => {
  try {
    const waveId = req.params.id;
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

router.get('/wave-suspensions', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
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

router.get('/waves/:id/suspension-timeline', requireAdmin, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const timeline = getWaveSuspensionTimeline(waveId);
    const activeSuspension = getActiveSuspension(waveId);
    res.json({ data: { timeline, activeSuspension } });
  } catch (e) { next(e); }
});

router.get('/suspension-reasons', requireAdmin, (req, res, next) => {
  try {
    res.json({ data: SUSPENSION_REASONS });
  } catch (e) { next(e); }
});

router.post('/waves/:id/transfer', requireAdmin, validateBody({
  targetUserId: { required: true, minLength: 1 },
  targetRole: { required: true, enum: ['picker', 'checker'] },
  reason: { required: true, minLength: 1 }
}), (req, res, next) => {
  try {
    const waveId = req.params.id;
    const { targetUserId, targetRole, reason, remark = '' } = req.body;
    const result = transferWave(
      waveId,
      req.user.id,
      req.user.realName || req.user.username,
      targetUserId,
      targetRole,
      reason,
      remark
    );
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.get('/waves/:id/transfer-check', requireAdmin, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const { targetRole } = req.query;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const result = canTransferWave(wave, targetRole);
    res.json({ data: result });
  } catch (e) { next(e); }
});

router.get('/waves/:id/transfer-history', requireAdmin, (req, res, next) => {
  try {
    const waveId = req.params.id;
    const wave = stores.waves().findById(waveId);
    if (!wave) return res.status(404).json({ error: '波次不存在' });
    const history = getWaveTransferHistory(waveId);
    const enriched = enrichTransferWithUsers(history);
    res.json({ data: enriched, total: enriched.length });
  } catch (e) { next(e); }
});

router.get('/wave-transfers', requireAdmin, (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req);
    const filters = {
      waveId: req.query.waveId,
      waveNo: req.query.waveNo,
      transferRole: req.query.transferRole,
      reason: req.query.reason,
      operatorId: req.query.operatorId,
      originalUserId: req.query.originalUserId,
      newUserId: req.query.newUserId,
      userId: req.query.userId,
      waveStatusAtTransfer: req.query.waveStatusAtTransfer,
      isSuspendedAtTransfer: req.query.isSuspendedAtTransfer,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    };
    const result = getTransferList(filters, page, pageSize);
    result.data = enrichTransferWithUsers(result.data);
    const availableFilters = {
      waveStatuses: [
        { value: '待拣货', label: '待拣货' },
        { value: '拣货中', label: '拣货中' },
        { value: '待复核', label: '待复核' },
        { value: '差异处理中', label: '差异处理中' },
        { value: '可包装', label: '可包装' },
        { value: '已关闭', label: '已关闭' }
      ],
      transferRoles: [
        { value: 'picker', label: '拣货员' },
        { value: 'checker', label: '复核员' }
      ],
      suspendedOptions: [
        { value: 'true', label: '挂起中' },
        { value: 'false', label: '未挂起' }
      ]
    };
    res.json({ 
      data: result.data, 
      total: result.total, 
      page, 
      pageSize, 
      totalPages: result.totalPages,
      availableFilters
    });
  } catch (e) { next(e); }
});

router.get('/transfer-reasons', requireAdmin, (req, res, next) => {
  try {
    res.json({ data: TRANSFER_REASONS });
  } catch (e) { next(e); }
});

router.get('/transferable-users', requireAdmin, (req, res, next) => {
  try {
    const { role } = req.query;
    const filter = { active: true };
    if (role) filter.role = role;
    const users = stores.users().find(filter);
    const data = users.map(u => ({
      id: u.id,
      username: u.username,
      realName: u.realName,
      role: u.role
    }));
    res.json({ data, total: data.length });
  } catch (e) { next(e); }
});

module.exports = router;
