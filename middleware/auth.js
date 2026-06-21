const { ROLES } = require('../models/constants');
const { stores } = require('../models');

function authMiddleware(...allowedRoles) {
  return (req, res, next) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    if (!userId || !userRole) {
      return res.status(401).json({ error: '缺少认证信息，请设置 X-User-Id 和 X-User-Role 头' });
    }
    if (!Object.values(ROLES).includes(userRole)) {
      return res.status(401).json({ error: '无效的角色类型' });
    }
    
    const isFirstUserBootstrap = 
      req.method === 'POST' && 
      (req.path === '/users' || req.originalUrl.endsWith('/api/admin/users')) && 
      stores.users().count() === 0;
    
    if (isFirstUserBootstrap) {
      req.user = { id: userId, role: userRole, isBootstrap: true };
      return next();
    }
    
    const user = stores.users().findById(userId);
    if (!user) {
      return res.status(401).json({ error: '用户不存在，请检查 X-User-Id' });
    }
    if (!user.active) {
      return res.status(401).json({ error: '用户已被禁用' });
    }
    if (user.role !== userRole) {
      return res.status(401).json({ error: `用户角色不匹配，该用户实际角色为 ${user.role}` });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: '权限不足，不允许访问该接口' });
    }
    req.user = { id: userId, role: userRole, username: user.username, realName: user.realName };
    next();
  };
}

function requireAdmin(req, res, next) {
  return authMiddleware(ROLES.ADMIN)(req, res, next);
}

function requirePicker(req, res, next) {
  return authMiddleware(ROLES.PICKER, ROLES.ADMIN)(req, res, next);
}

function requireChecker(req, res, next) {
  return authMiddleware(ROLES.CHECKER, ROLES.ADMIN)(req, res, next);
}

function errorHandler(err, req, res, next) {
  console.error('[Error]', err.message, err.stack);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '服务器内部错误' });
}

function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`字段 ${field} 是必填项`);
        continue;
      }
      if (value !== undefined && value !== null && value !== '') {
        if (rules.type === 'number' && typeof value !== 'number' && isNaN(Number(value))) {
          errors.push(`字段 ${field} 必须是数字`);
        }
        if (rules.type === 'integer' && (!Number.isInteger(Number(value)))) {
          errors.push(`字段 ${field} 必须是整数`);
        }
        if (rules.type === 'array' && !Array.isArray(value)) {
          errors.push(`字段 ${field} 必须是数组`);
        }
        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`字段 ${field} 的值必须是以下之一: ${rules.enum.join(', ')}`);
        }
        if (rules.min !== undefined && Number(value) < rules.min) {
          errors.push(`字段 ${field} 的值不能小于 ${rules.min}`);
        }
        if (rules.max !== undefined && Number(value) > rules.max) {
          errors.push(`字段 ${field} 的值不能大于 ${rules.max}`);
        }
        if (rules.minLength !== undefined && String(value).length < rules.minLength) {
          errors.push(`字段 ${field} 的长度不能少于 ${rules.minLength} 个字符`);
        }
      }
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: '参数校验失败', details: errors });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  requireAdmin,
  requirePicker,
  requireChecker,
  errorHandler,
  validateBody
};
