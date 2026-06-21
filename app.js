const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { errorHandler } = require('./middleware/auth');
const { runAllChecks } = require('./utils/detector');
const { WAVE_STATUS, DISCREPANCY_LEVEL, ROLES, SUSPENSION_REASONS, SUSPENSION_STATUS, SUSPENDABLE_STATUSES, TRANSFER_REASONS, TRANSFERABLE_ROLES, TRANSFERABLE_STATUSES } = require('./models/constants');

const app = express();
const PORT = 8145;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: '仓储拣货波次管理服务',
    version: '1.0.0',
    port: PORT,
    status: 'running',
    endpoints: {
      admin: '/api/admin/*',
      picker: '/api/picker/*',
      checker: '/api/checker/*',
      query: '/api/query/*',
      health: '/api/health'
    },
    roles: Object.values(ROLES),
    waveStatuses: Object.values(WAVE_STATUS),
    discrepancyLevels: Object.values(DISCREPANCY_LEVEL),
    suspensionReasons: SUSPENSION_REASONS,
    suspensionStatuses: Object.values(SUSPENSION_STATUS),
    suspendableStatuses: SUSPENDABLE_STATUSES,
    transferReasons: TRANSFER_REASONS,
    transferableRoles: TRANSFERABLE_ROLES,
    transferableStatuses: TRANSFERABLE_STATUSES
  });
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api/picker', require('./routes/picker'));
app.use('/api/checker', require('./routes/checker'));
app.use('/api', require('./routes/query'));

app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.url}` });
});

setInterval(() => {
  try {
    runAllChecks();
  } catch (e) {
    console.error('[定时检测错误]', e.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`============================================`);
  console.log(`仓储拣货波次管理服务启动成功`);
  console.log(`服务端口: ${PORT}`);
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log(`接口文档: http://localhost:${PORT}/`);
  console.log(`健康检查: http://localhost:${PORT}/api/health`);
  console.log(`============================================`);
  try {
    runAllChecks();
  } catch (e) {
    console.error('[启动检测错误]', e.message);
  }
});

module.exports = app;
