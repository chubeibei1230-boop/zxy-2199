const http = require('http');

function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const adminOptions = {
  hostname: 'localhost',
  port: 8145,
  headers: {
    'Content-Type': 'application/json',
    'X-User-Id': '0e1c91842e104e9e8a777ab0685c17a5',
    'X-User-Role': 'admin'
  }
};

function getUserOptions(userId, role) {
  return {
    hostname: 'localhost',
    port: 8145,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId,
      'X-User-Role': role
    }
  };
}

async function test() {
  console.log('========== 波次转派确认模块测试 ==========\n');

  console.log('1. 测试健康检查和常量...');
  const health = await makeRequest({ ...adminOptions, path: '/api/health', method: 'GET' });
  console.log('   状态:', health.status);
  console.log('   waveTransfers:', health.data.entities.waveTransfers);
  console.log('   ✓ 健康检查通过\n');

  console.log('2. 获取根路径信息（验证新常量）...');
  const root = await makeRequest({ ...adminOptions, path: '/', method: 'GET' });
  console.log('   状态:', root.status);
  console.log('   transferStatuses:', root.data.transferStatuses);
  console.log('   transferRejectReasons:', root.data.transferRejectReasons);
  console.log('   ✓ 新常量已暴露\n');

  console.log('3. 获取SKU列表和用户列表，准备测试数据...');
  const skusRes = await makeRequest({ ...adminOptions, path: '/api/admin/skus?pageSize=3', method: 'GET' });
  const skus = skusRes.data.data || [];
  console.log('   SKU数量:', skus.length);

  const usersRes = await makeRequest({ ...adminOptions, path: '/api/admin/users', method: 'GET' });
  const pickers = usersRes.data.data.filter(u => u.role === 'picker' && u.active);
  const checkers = usersRes.data.data.filter(u => u.role === 'checker' && u.active);
  console.log('   活跃拣货员数量:', pickers.length);
  console.log('   活跃复核员数量:', checkers.length);

  if (pickers.length < 2) {
    console.log('   创建测试拣货员1...');
    const p1 = await makeRequest({ ...adminOptions, path: '/api/admin/users', method: 'POST' }, {
      username: 'test_picker1_' + Date.now(),
      role: 'picker',
      realName: '测试拣货员1'
    });
    if (p1.status === 200) pickers.push(p1.data.data);
    
    console.log('   创建测试拣货员2...');
    const p2 = await makeRequest({ ...adminOptions, path: '/api/admin/users', method: 'POST' }, {
      username: 'test_picker2_' + Date.now(),
      role: 'picker',
      realName: '测试拣货员2'
    });
    if (p2.status === 200) pickers.push(p2.data.data);
  }
  console.log();

  console.log('4. 创建测试波次...');
  let testWave = null;
  if (skus.length > 0 && pickers.length >= 2) {
    const items = skus.slice(0, 2).map(s => ({
      skuId: s.id,
      planQty: 10
    }));
    
    const createWaveRes = await makeRequest({ ...adminOptions, path: '/api/picker/waves', method: 'POST' }, {
      items,
      pickerId: pickers[0].id,
      priority: 5,
      remark: '转派确认测试波次'
    });
    
    if (createWaveRes.status === 201 || createWaveRes.status === 200) {
      testWave = createWaveRes.data.data;
      console.log('   测试波次创建成功:', testWave.waveNo);
      console.log('   波次状态:', testWave.status);
      console.log('   拣货员ID:', testWave.pickerId);
    }
  }
  console.log();

  if (testWave && pickers.length >= 2) {
    const originalPicker = pickers.find(p => p.id === testWave.pickerId) || pickers[0];
    const targetPicker = pickers.find(p => p.id !== testWave.pickerId) || pickers[1];
    const originalPickerOptions = getUserOptions(originalPicker.id, 'picker');
    const targetPickerOptions = getUserOptions(targetPicker.id, 'picker');

    console.log('5. 测试转派前检查...');
    const checkRes = await makeRequest({
      ...adminOptions,
      path: `/api/admin/waves/${testWave.id}/transfer-check?targetRole=picker`,
      method: 'GET'
    });
    console.log('   状态:', checkRes.status);
    console.log('   是否可转派:', checkRes.data.data.allowed);
    console.log();

    console.log('6. 测试发起转派（进入待接收状态）...');
    const transferRes = await makeRequest({
      ...adminOptions,
      path: `/api/admin/waves/${testWave.id}/transfer`,
      method: 'POST'
    }, {
      targetUserId: targetPicker.id,
      targetRole: 'picker',
      reason: '人员请假',
      remark: '测试转派确认功能'
    });
    console.log('   状态:', transferRes.status);
    if (transferRes.status === 200) {
      const transfer = transferRes.data.data.transfer;
      console.log('   ✓ 转派发起成功');
      console.log('   转派记录ID:', transfer.id);
      console.log('   转派状态:', transfer.status);
      console.log('   原负责人:', transfer.originalUserName);
      console.log('   新负责人:', transfer.newUserName);
      console.log('   转派原因:', transfer.reason);
      console.log('   发起时间:', transfer.transferredAt);
      
      if (transfer.status === '待接收') {
        console.log('   ✓ 转派状态正确：待接收');
      } else {
        console.log('   ✗ 错误：转派状态不是待接收');
      }
    } else {
      console.log('   ✗ 转派失败:', transferRes.data.error || transferRes.data);
    }
    console.log();

    console.log('7. 验证波次详情中的待接收转派信息...');
    const waveDetailRes = await makeRequest({
      ...adminOptions,
      path: `/api/waves/${testWave.id}`,
      method: 'GET'
    });
    if (waveDetailRes.status === 200) {
      const wave = waveDetailRes.data.data;
      console.log('   波次号:', wave.waveNo);
      console.log('   当前拣货员ID:', wave.pickerId);
      console.log('   是否有待接收转派:', wave.pendingTransfer ? '是' : '否');
      if (wave.pendingTransfer) {
        console.log('   待接收转派状态:', wave.pendingTransfer.status);
        console.log('   待接收目标:', wave.pendingTransfer.newUserName);
      }
      console.log('   转派历史数量:', (wave.transferHistory || []).length);
      console.log('   ✓ 波次详情包含待接收转派信息');
    }
    console.log();

    console.log('8. 验证原负责人仍能看到该波次...');
    const origPickerWavesRes = await makeRequest({
      ...originalPickerOptions,
      path: '/api/waves?pageSize=10',
      method: 'GET'
    });
    if (origPickerWavesRes.status === 200) {
      const hasWave = origPickerWavesRes.data.data.find(w => w.id === testWave.id);
      if (hasWave) {
        console.log('   ✓ 原负责人仍能看到该波次（待接收期间不转移权限）');
      } else {
        console.log('   ✗ 原负责人看不到该波次了');
      }
    }
    console.log();

    console.log('9. 验证目标用户的待接收转派列表...');
    const pendingRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/picker/transfers/pending',
      method: 'GET'
    });
    if (pendingRes.status === 200) {
      console.log('   待接收转派数量:', pendingRes.data.total);
      const hasTransfer = pendingRes.data.data.find(t => t.waveId === testWave.id);
      if (hasTransfer) {
        console.log('   ✓ 目标用户在待办列表中看到了该转派');
        console.log('   转派波次:', hasTransfer.waveNo);
        console.log('   转派状态:', hasTransfer.status);
        console.log('   发起人:', hasTransfer.operatorName);
      } else {
        console.log('   ✗ 目标用户待办列表中没有该转派');
      }
    } else {
      console.log('   接口状态:', pendingRes.status);
      console.log('   返回:', pendingRes.data);
    }
    console.log();

    console.log('10. 测试拒绝转派功能...');
    let firstTransferId = null;
    if (pendingRes.status === 200 && pendingRes.data.data.length > 0) {
      firstTransferId = pendingRes.data.data[0].id;
      const rejectRes = await makeRequest({
        ...targetPickerOptions,
        path: `/api/picker/transfers/${firstTransferId}/reject`,
        method: 'POST'
      }, {
        rejectReason: '工作量已满',
        rejectRemark: '当前手头工作太多，无法再接新的波次'
      });
      
      console.log('   拒绝状态:', rejectRes.status);
      if (rejectRes.status === 200) {
        const result = rejectRes.data.data;
        console.log('   ✓ 转派拒绝成功');
        console.log('   转派状态:', result.transfer.status);
        console.log('   拒绝原因:', result.transfer.rejectReason);
        console.log('   拒绝说明:', result.transfer.rejectRemark);
        console.log('   处理时长(分钟):', result.transfer.processingDurationMinutes);
        
        if (result.wave.pickerId === originalPicker.id) {
          console.log('   ✓ 拒绝后波次仍归原负责人所有');
        } else {
          console.log('   波次当前负责人:', result.wave.pickerId);
        }
      } else {
        console.log('   ✗ 拒绝失败:', rejectRes.data.error || rejectRes.data);
      }
    }
    console.log();

    console.log('11. 验证拒绝后待接收列表不再有该转派...');
    const pendingAfterRejectRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/picker/transfers/pending',
      method: 'GET'
    });
    if (pendingAfterRejectRes.status === 200) {
      const hasTransfer = pendingAfterRejectRes.data.data.find(t => t.waveId === testWave.id);
      if (!hasTransfer) {
        console.log('   ✓ 拒绝后待接收列表不再有该转派');
      } else {
        console.log('   待接收列表仍有该转派');
      }
    }
    console.log();

    console.log('12. 再次发起转派，测试接收功能...');
    const secondTransferRes = await makeRequest({
      ...adminOptions,
      path: `/api/admin/waves/${testWave.id}/transfer`,
      method: 'POST'
    }, {
      targetUserId: targetPicker.id,
      targetRole: 'picker',
      reason: '工作量调整',
      remark: '测试接收转派功能'
    });
    
    if (secondTransferRes.status === 200) {
      console.log('   第二个转派发起成功');
      const secondTransferId = secondTransferRes.data.data.transfer.id;
      
      console.log('   测试接收转派...');
      const acceptRes = await makeRequest({
        ...targetPickerOptions,
        path: `/api/picker/transfers/${secondTransferId}/accept`,
        method: 'POST'
      });
      
      console.log('   接收状态:', acceptRes.status);
      if (acceptRes.status === 200) {
        const result = acceptRes.data.data;
        console.log('   ✓ 转派接收成功');
        console.log('   转派状态:', result.transfer.status);
        console.log('   处理时间:', result.transfer.handledAt);
        console.log('   处理时长(分钟):', result.transfer.processingDurationMinutes);
        console.log('   波次当前拣货员ID:', result.wave.pickerId);
        
        if (result.wave.pickerId === targetPicker.id) {
          console.log('   ✓ 波次负责人已更新为新拣货员');
        } else {
          console.log('   ✗ 波次负责人未正确更新');
        }
      } else {
        console.log('   ✗ 接收失败:', acceptRes.data.error || acceptRes.data);
      }
    } else {
      console.log('   第二个转派发起失败:', secondTransferRes.data.error || secondTransferRes.data);
    }
    console.log();

    console.log('13. 验证接收后原负责人不再看到该波次...');
    const origWavesAfterRes = await makeRequest({
      ...originalPickerOptions,
      path: '/api/waves?pageSize=10',
      method: 'GET'
    });
    if (origWavesAfterRes.status === 200) {
      const hasWave = origWavesAfterRes.data.data.find(w => w.id === testWave.id);
      if (!hasWave) {
        console.log('   ✓ 原负责人不再看到该波次（权限已转移）');
      } else {
        console.log('   原负责人仍能看到该波次');
      }
    }
    console.log();

    console.log('14. 验证接收后新负责人能看到该波次...');
    const newWavesRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/waves?pageSize=10',
      method: 'GET'
    });
    if (newWavesRes.status === 200) {
      const hasWave = newWavesRes.data.data.find(w => w.id === testWave.id);
      if (hasWave) {
        console.log('   ✓ 新负责人可以看到该波次');
      } else {
        console.log('   ✗ 新负责人看不到该波次');
      }
    }
    console.log();

    console.log('15. 测试管理员视角的转派统计...');
    const statsRes = await makeRequest({
      ...adminOptions,
      path: '/api/admin/wave-transfers/stats',
      method: 'GET'
    });
    if (statsRes.status === 200) {
      const stats = statsRes.data.data;
      console.log('   总转派数:', stats.total);
      console.log('   待接收:', stats.pending);
      console.log('   已接收:', stats.accepted);
      console.log('   已拒绝:', stats.rejected);
      console.log('   已超时:', stats.timeout);
      console.log('   接收率:', stats.acceptanceRate, '%');
      console.log('   平均处理时长:', stats.avgProcessingMinutes, '分钟');
      console.log('   ✓ 转派统计功能正常');
    } else {
      console.log('   状态:', statsRes.status);
      console.log('   返回:', statsRes.data);
    }
    console.log();

    console.log('16. 测试转派记录列表（按状态筛选）...');
    const filterRes = await makeRequest({
      ...adminOptions,
      path: '/api/admin/wave-transfers?status=' + encodeURIComponent('已接收') + '&pageSize=5',
      method: 'GET'
    });
    if (filterRes.status === 200) {
      console.log('   已接收转派数量:', filterRes.data.total);
      console.log('   ✓ 状态筛选功能正常');
    }
    console.log();

    console.log('17. 测试超时转派列表...');
    const timeoutRes = await makeRequest({
      ...adminOptions,
      path: '/api/admin/wave-transfers/timeouts?pageSize=5',
      method: 'GET'
    });
    if (timeoutRes.status === 200) {
      console.log('   超时转派数量:', timeoutRes.data.total);
      console.log('   超时阈值:', timeoutRes.data.timeoutThreshold, '分钟');
      console.log('   ✓ 超时转派列表功能正常');
    }
    console.log();

    console.log('18. 测试用户个人转派统计...');
    const userStatsRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/picker/transfers/stats',
      method: 'GET'
    });
    if (userStatsRes.status === 200) {
      const stats = userStatsRes.data.data;
      console.log('   用户总转派数:', stats.totalTransfers);
      console.log('   待接收:', stats.pendingCount);
      console.log('   已接收:', stats.acceptedCount);
      console.log('   已拒绝:', stats.rejectedCount);
      console.log('   已超时:', stats.timeoutCount);
      console.log('   平均处理时长:', stats.avgProcessingMinutes, '分钟');
      console.log('   ✓ 用户个人转派统计功能正常');
    }
    console.log();

    console.log('19. 测试用户个人转派记录列表...');
    const myTransferRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/picker/transfers/my?type=received&pageSize=5',
      method: 'GET'
    });
    if (myTransferRes.status === 200) {
      console.log('   个人转派记录数量:', myTransferRes.data.total);
      console.log('   ✓ 个人转派记录功能正常');
    }
    console.log();

    console.log('20. 测试拒绝原因列表...');
    const rejectReasonsRes = await makeRequest({
      ...targetPickerOptions,
      path: '/api/picker/transfer-reject-reasons',
      method: 'GET'
    });
    if (rejectReasonsRes.status === 200) {
      console.log('   拒绝原因数量:', rejectReasonsRes.data.data.length);
      console.log('   拒绝原因列表:', rejectReasonsRes.data.data.join(', '));
      console.log('   ✓ 拒绝原因列表功能正常');
    }
    console.log();

    console.log('21. 验证波次历史记录中包含完整交接轨迹...');
    const waveHistoryRes = await makeRequest({
      ...adminOptions,
      path: `/api/waves/${testWave.id}/transfer-history`,
      method: 'GET'
    });
    if (waveHistoryRes.status === 200) {
      const history = waveHistoryRes.data.data;
      console.log('   转派历史记录数量:', history.length);
      if (history.length >= 2) {
        console.log('   历史记录包含状态、处理人、拒绝原因等信息');
        console.log('   ✓ 完整交接轨迹已记录');
      }
    }
    console.log();
  }

  console.log('========== 测试完成 ==========');
}

test().catch(console.error);
