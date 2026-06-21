const ROLES = {
  ADMIN: 'admin',
  PICKER: 'picker',
  CHECKER: 'checker'
};

const WAVE_STATUS = {
  PENDING: '待拣货',
  PICKING: '拣货中',
  TO_CHECK: '待复核',
  DISCREPANCY: '差异处理中',
  TO_PACK: '可包装',
  CLOSED: '已关闭'
};

const WAVE_STATUS_FLOW = {
  [WAVE_STATUS.PENDING]: [WAVE_STATUS.PICKING],
  [WAVE_STATUS.PICKING]: [WAVE_STATUS.TO_CHECK],
  [WAVE_STATUS.TO_CHECK]: [WAVE_STATUS.DISCREPANCY, WAVE_STATUS.TO_PACK],
  [WAVE_STATUS.DISCREPANCY]: [WAVE_STATUS.TO_PACK],
  [WAVE_STATUS.TO_PACK]: [WAVE_STATUS.CLOSED]
};

const DISCREPANCY_LEVEL = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  CRITICAL: '严重'
};

const PATH_DEVIATION_REASONS = [
  '货位被占用',
  '临时通道阻塞',
  '货架调整',
  '其他'
];

const STOCKOUT_REASONS = [
  '库存不足',
  '货位错误',
  '货物破损',
  '货物丢失',
  '其他'
];

const WRONG_ITEM_REASONS = [
  '拣错SKU',
  '批次错误',
  '规格错误',
  '包装错误',
  '其他'
];

const PACKING_SUGGESTIONS = [
  '标准包装',
  '加强防护',
  '冷链接运',
  '大件单独发',
  '易碎贴标',
  '其他'
];

const SUSPENSION_REASONS = [
  '设备故障',
  '物料短缺',
  '人员不足',
  '现场异常',
  '系统问题',
  '质量问题',
  '安全问题',
  '其他'
];

const SUSPENSION_STATUS = {
  ACTIVE: '挂起中',
  RESUMED: '已恢复',
  TIMEOUT: '已超时'
};

const SUSPENDABLE_STATUSES = [
  '拣货中',
  '待复核',
  '差异处理中'
];

const TRANSFER_REASONS = [
  '人员请假',
  '工作量调整',
  '人员离职',
  '技能匹配',
  '紧急支援',
  '其他'
];

const TRANSFERABLE_ROLES = ['picker', 'checker'];

const TRANSFERABLE_STATUSES = [
  '待拣货',
  '拣货中',
  '待复核',
  '差异处理中',
  '可包装'
];

const CONFIG_DEFAULTS = {
  REVIEW_RATIO: 1.0,
  PATH_DEVIATION_THRESHOLD: 3,
  LOCATION_DISCREPANCY_THRESHOLD: 3,
  REVIEW_TIMEOUT_MINUTES: 120,
  SUSPENSION_TIMEOUT_MINUTES: 240,
  WAVE_EFFICIENCY_BUCKETS: [
    { min: 0, max: 30, label: '<30分钟' },
    { min: 30, max: 60, label: '30-60分钟' },
    { min: 60, max: 120, label: '1-2小时' },
    { min: 120, max: 240, label: '2-4小时' },
    { min: 240, max: Infinity, label: '>4小时' }
  ]
};

module.exports = {
  ROLES,
  WAVE_STATUS,
  WAVE_STATUS_FLOW,
  DISCREPANCY_LEVEL,
  PATH_DEVIATION_REASONS,
  STOCKOUT_REASONS,
  WRONG_ITEM_REASONS,
  PACKING_SUGGESTIONS,
  SUSPENSION_REASONS,
  SUSPENSION_STATUS,
  SUSPENDABLE_STATUSES,
  TRANSFER_REASONS,
  TRANSFERABLE_ROLES,
  TRANSFERABLE_STATUSES,
  CONFIG_DEFAULTS
};
