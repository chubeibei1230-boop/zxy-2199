const http = require('http');

const BASE_URL = 'http://localhost:8145';
const ADMIN_HEADERS = {
  'X-User-Id': '0e1c91842e104e9e8a777ab0685c17a5',
  'X-User-Role': 'admin',
  'Content-Type': 'application/json'
};
const PICKER1_HEADERS = {
  'X-User-Id': '14b829f3d136452787762916baa16704',
  'X-User-Role': 'picker',
  'Content-Type': 'application/json'
};
const PICKER2_HEADERS = {
  'X-User-Id': '4e289c6d0b9e41bea5cccd60ff218c6b',
  'X-User-Role': 'picker',
  'Content-Type': 'application/json'
};
const CHECKER1_HEADERS = {
  'X-User-Id': '50a1cfa0000b4f93847bec7bb80480a4',
  'X-User-Role': 'checker',
  'Content-Type': 'application/json'
};

function request(method, path, headers, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('=== 波次转派模块 Bug 修复验证 ===\n');
  
  // 1. 获取一个合适的测试波次
  console.log('1. 获取测试波次...');
  const allWavesRes = await request('GET', '/api/waves?pageSize=50', ADMIN_HEADERS);
  let testWave = null;
  if (allWavesRes.status === 200 && allWavesRes.body.data) {
    // 优先找拣货中或待拣货的波次，且当前负责人是 Picker Li
    const pickableStatuses = ['拣货中', '待拣货'];
    for (const w of allWavesRes.body.data) {
      if (pickableStatuses.includes(w.status) && !w.isSuspended) {
        testWave = w;
        break;
      }
    }
    // 如果没有找到，就找任意一个可转派的波次
    if (!testWave) {
      const transferableStatuses = ['待拣货', '拣货中', '待复核', '差异处理中', '可包装'];
      for (const w of allWavesRes.body.data) {
        if (transferableStatuses.includes(w.status) && !w.isSuspended) {
          testWave = w;
          break;
        }
      }
    }
  }
  if (!testWave) {
    console.log('  错误: 未找到可用的测试波次');
    console.log('  所有波次状态:');
    if (allWavesRes.body && allWavesRes.body.data) {
      for (const w of allWavesRes.body.data.slice(0, 10)) {
        console.log(`    ${w.waveNo}: ${w.status}, pickerId=${w.pickerId}, isSuspended=${w.isSuspended}`);
      }
    }
    return;
  }
  const testWaveId = testWave.id;
  const testWaveNo = testWave.waveNo;
  console.log(`  找到测试波次: ${testWaveNo}, 状态: ${testWave.status}, 当前pickerId: ${testWave.pickerId}`);
  
  // 2. 执行转派
  console.log('\n2. 执行波次转派...');
  // 根据波次状态确定转派目标角色
  const pickerStatuses = ['待拣货', '拣货中'];
  const checkerStatuses = ['待复核', '差异处理中', '可包装'];
  let targetRole, targetUserId, targetUserHeaders, originalUserHeaders;
  
  if (pickerStatuses.includes(testWave.status)) {
    targetRole = 'picker';
    // 目标用户是 Picker Zhang
    targetUserId = '4e289c6d0b9e41bea5cccd60ff218c6b';
    targetUserHeaders = PICKER2_HEADERS;
    // 原负责人是 Picker Li
    originalUserHeaders = PICKER1_HEADERS;
  } else if (checkerStatuses.includes(testWave.status)) {
    targetRole = 'checker';
    // 目标用户是 Checker Wang
    targetUserId = '50a1cfa0000b4f93847bec7bb80480a4';
    targetUserHeaders = CHECKER1_HEADERS;
    // 原负责人是 Checker Wang（如果是复核相关状态，我们转给同一个人也没关系，主要测试权限校验逻辑）
    originalUserHeaders = CHECKER1_HEADERS;
  } else {
    console.log('  错误: 波次状态不支持转派');
    return;
  }
  
  // 确保目标用户与当前负责人不同
  const currentField = targetRole === 'picker' ? 'pickerId' : 'checkerId';
  if (testWave[currentField] === targetUserId) {
    console.log('  目标用户与当前负责人相同，跳过转派，直接测试其他功能');
  } else {
    const transferRes = await request('POST', `/api/admin/waves/${testWaveId}/transfer`, ADMIN_HEADERS, {
      targetUserId,
      targetRole,
      reason: '人员请假',
      remark: '测试转派权限控制'
    });
    if (transferRes.status !== 200) {
      console.log(`  转派失败: ${transferRes.status}`, transferRes.body);
      return;
    }
    console.log('  ✓ 转派成功');
    console.log(`  转派角色: ${targetRole}`);
    console.log(`  返回数据:`, JSON.stringify(transferRes.body, null, 2).slice(0, 500));
    const transferData = transferRes.body.transfer || transferRes.body.data?.transfer || transferRes.body;
    if (transferData.originalUserId) {
      console.log(`  原负责人ID: ${transferData.originalUserId}`);
      console.log(`  新负责人ID: ${transferData.newUserId}`);
    }
  }
  
  // 3. 测试原负责人是否还能操作
  console.log('\n3. 测试原负责人操作权限（应该被拒绝）...');
  let testOperationPath;
  if (targetRole === 'picker') {
    testOperationPath = `/api/picker/waves/${testWaveId}/start-picking`;
  } else {
    testOperationPath = `/api/checker/waves/${testWaveId}/start-checking`;
  }
  const operationRes = await request('POST', testOperationPath, originalUserHeaders);
  if (operationRes.status === 403 && operationRes.body.error) {
    console.log('  ✓ 原负责人无法操作，权限控制生效');
    console.log(`    错误信息: ${operationRes.body.error}`);
  } else if (operationRes.status === 400 && operationRes.body.error && operationRes.body.error.includes('挂起')) {
    console.log('  波次处于挂起状态，无法测试权限（正常现象）');
  } else if (operationRes.status === 400 && operationRes.body.error) {
    // 可能是状态不对，但这也说明原负责人可以访问到状态检查，说明权限有问题
    console.log('  ⚠ 原负责人可以访问接口（但被状态检查拦截），权限检查可能不够前置');
    console.log(`    状态: ${operationRes.status}, 错误: ${operationRes.body.error}`);
  } else {
    console.log('  ✗ 原负责人仍然可以操作！BUG未修复');
    console.log(`    状态: ${operationRes.status}`, operationRes.body);
  }
  
  // 4. 测试新负责人是否可以操作
  console.log('\n4. 测试新负责人操作权限（应该允许）...');
  const waveDetailRes = await request('GET', `/api/waves/${testWaveId}`, targetUserHeaders);
  if (waveDetailRes.status === 200) {
    console.log('  ✓ 新负责人可以查看波次详情');
    if (waveDetailRes.body.data.lastTransfer) {
      console.log('  ✓ 波次详情包含转派信息');
    }
  } else if (waveDetailRes.status === 403) {
    console.log('  ⚠ 新负责人无权查看波次（可能是数据权限控制，需要检查）');
  } else {
    console.log('  ✗ 新负责人无法查看波次！');
    console.log(`    状态: ${waveDetailRes.status}`, waveDetailRes.body);
  }
  
  // 5. 测试挂起中波次转派
  console.log('\n5. 测试挂起中波次转派检查...');
  // 先找一个没有挂起的波次挂起它
  let suspendWave = null;
  if (allWavesRes.status === 200 && allWavesRes.body.data) {
    for (const w of allWavesRes.body.data) {
      if (!w.isSuspended && w.id !== testWaveId && ['待拣货', '拣货中', '待复核', '差异处理中'].includes(w.status)) {
        suspendWave = w;
        break;
      }
    }
  }
  if (suspendWave) {
    console.log(`  找到测试波次: ${suspendWave.waveNo}, 状态: ${suspendWave.status}`);
    // 挂起波次
    const suspendRes = await request('POST', `/api/admin/waves/${suspendWave.id}/suspend`, ADMIN_HEADERS, {
      reason: '人员不足',
      responsiblePerson: '测试责任人',
      remark: '测试挂起转派',
      expectedResumeAt: new Date(Date.now() + 86400000).toISOString()
    });
    if (suspendRes.status === 200 || suspendRes.status === 201) {
      console.log('  ✓ 波次已挂起');
      // 确定转派目标角色
      const suspendTargetRole = ['待拣货', '拣货中'].includes(suspendWave.status) ? 'picker' : 'checker';
      // 检查转派可行性
      const checkRes = await request('GET', `/api/admin/waves/${suspendWave.id}/transfer-check?targetRole=${suspendTargetRole}`, ADMIN_HEADERS);
      if (checkRes.status === 200 && checkRes.body.data.allowed && checkRes.body.data.isSuspended) {
        console.log('  ✓ 挂起中波次可以转派，但有警告提示');
        console.log(`    警告信息: ${checkRes.body.data.warning}`);
      } else {
        console.log('  ✗ 挂起中波次转派检查不正确', checkRes.body);
      }
      
      // 实际执行转派
      const suspendTargetUserId = suspendTargetRole === 'picker' 
        ? '4e289c6d0b9e41bea5cccd60ff218c6b' 
        : '50a1cfa0000b4f93847bec7bb80480a4';
      const suspendTransferRes = await request('POST', `/api/admin/waves/${suspendWave.id}/transfer`, ADMIN_HEADERS, {
        targetUserId: suspendTargetUserId,
        targetRole: suspendTargetRole,
        reason: '人员请假',
        remark: '测试挂起波次转派'
      });
      if (suspendTransferRes.status === 200) {
        console.log('  ✓ 挂起中波次转派成功');
        console.log(`    转派时挂起状态记录: ${suspendTransferRes.body.transfer.isSuspendedAtTransfer}`);
      } else {
        console.log('  ✗ 挂起中波次转派失败:', suspendTransferRes.body);
      }
    } else {
      console.log('  挂起失败:', suspendRes.body);
    }
  } else {
    console.log('  未找到可挂起的测试波次，跳过挂起测试');
  }
  
  // 6. 测试管理端转派记录筛选
  console.log('\n6. 测试管理端转派记录筛选功能...');
  
  // 测试按波次状态筛选
  const statusFilter = encodeURIComponent('拣货中');
  const statusRes = await request('GET', `/api/admin/wave-transfers?waveStatusAtTransfer=${statusFilter}&pageSize=5`, ADMIN_HEADERS);
  if (statusRes.status === 200) {
    console.log(`  ✓ 按波次状态筛选: 找到 ${statusRes.body.total} 条"拣货中"状态的转派记录`);
    if (statusRes.body.availableFilters) {
      console.log('  ✓ 返回了可用筛选选项');
      console.log(`    波次状态选项: ${statusRes.body.availableFilters.waveStatuses.map(s => s.label).join(', ')}`);
      console.log(`    挂起状态选项: ${statusRes.body.availableFilters.suspendedOptions.map(s => s.label).join(', ')}`);
    }
  } else {
    console.log('  ✗ 按状态筛选失败:', statusRes.body);
  }
  
  // 测试按挂起状态筛选
  const suspendedRes = await request('GET', '/api/admin/wave-transfers?isSuspendedAtTransfer=true&pageSize=5', ADMIN_HEADERS);
  if (suspendedRes.status === 200) {
    console.log(`  ✓ 按挂起状态筛选: 找到 ${suspendedRes.body.total} 条挂起中的转派记录`);
  } else {
    console.log('  ✗ 按挂起状态筛选失败:', suspendedRes.body);
  }
  
  // 测试按未挂起筛选
  const notSuspendedRes = await request('GET', '/api/admin/wave-transfers?isSuspendedAtTransfer=false&pageSize=5', ADMIN_HEADERS);
  if (notSuspendedRes.status === 200) {
    console.log(`  ✓ 按未挂起状态筛选: 找到 ${notSuspendedRes.body.total} 条未挂起的转派记录`);
  } else {
    console.log('  ✗ 按未挂起状态筛选失败:', notSuspendedRes.body);
  }
  
  // 7. 测试原负责人的波次可见性
  console.log('\n7. 测试原负责人波次可见性...');
  const originalPickerWavesRes = await request('GET', '/api/waves', originalUserHeaders);
  if (originalPickerWavesRes.status === 200) {
    const canSeeTransferredWave = originalPickerWavesRes.body.data.some(w => w.id === testWaveId);
    if (!canSeeTransferredWave) {
      console.log('  ✓ 原负责人不再看到被转派的波次');
    } else {
      console.log('  ✗ 原负责人仍然可以看到被转派的波次！');
    }
  }
  
  // 8. 测试新负责人的波次可见性
  console.log('\n8. 测试新负责人波次可见性...');
  const newPickerWavesRes = await request('GET', '/api/waves', targetUserHeaders);
  if (newPickerWavesRes.status === 200) {
    const canSeeTransferredWave = newPickerWavesRes.body.data.some(w => w.id === testWaveId);
    if (canSeeTransferredWave) {
      console.log('  ✓ 新负责人可以看到接手的波次');
    } else {
      console.log('  ⚠ 新负责人看不到接手的波次（可能是状态过滤导致）');
      console.log(`    新负责人可见波次数量: ${newPickerWavesRes.body.data.length}`);
      if (newPickerWavesRes.body.data.length > 0) {
        console.log(`    可见波次: ${newPickerWavesRes.body.data.slice(0,3).map(w => w.waveNo).join(', ')}`);
      }
    }
  }
  
  console.log('\n=== 测试完成 ===');
}

runTests().catch(console.error);
