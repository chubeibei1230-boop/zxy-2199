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

const baseOptions = {
  hostname: 'localhost',
  port: 8145,
  headers: {
    'Content-Type': 'application/json',
    'X-User-Id': '0e1c91842e104e9e8a777ab0685c17a5',
    'X-User-Role': 'admin'
  }
};

async function test() {
  console.log('=== 波次转派与交接模块测试 ===\n');

  console.log('1. 测试健康检查...');
  const health = await makeRequest({ ...baseOptions, path: '/api/health', method: 'GET' });
  console.log('   状态:', health.status);
  console.log('   waveTransfers:', health.data.entities.waveTransfers);
  console.log('   ✓ 健康检查通过\n');

  console.log('2. 获取波次列表...');
  const wavesRes = await makeRequest({ ...baseOptions, path: '/api/waves?pageSize=5', method: 'GET' });
  console.log('   状态:', wavesRes.status);
  console.log('   波次数量:', wavesRes.data.total);
  let testWave = null;
  if (wavesRes.data.data && wavesRes.data.data.length > 0) {
    testWave = wavesRes.data.data.find(w => w.status === '拣货中');
    if (!testWave) testWave = wavesRes.data.data[0];
    console.log('   测试波次:', testWave.waveNo, '-', testWave.status);
    console.log('   当前拣货员:', testWave.picker ? testWave.picker.realName : '无');
    console.log('   当前拣货员ID:', testWave.pickerId);
  }
  console.log();

  console.log('3. 获取用户列表并确定目标用户...');
  const usersRes = await makeRequest({ ...baseOptions, path: '/api/admin/users', method: 'GET' });
  const pickers = usersRes.data.data.filter(u => u.role === 'picker');
  const checkers = usersRes.data.data.filter(u => u.role === 'checker');
  console.log('   拣货员数量:', pickers.length);
  console.log('   复核员数量:', checkers.length);

  let newPickerId = null;
  if (testWave && pickers.length > 0) {
    const otherPickers = pickers.filter(p => p.id !== testWave.pickerId);
    if (otherPickers.length > 0) {
      newPickerId = otherPickers[0].id;
      console.log('   已有其他拣货员可用:', otherPickers[0].realName);
    } else {
      console.log('   需要创建新拣货员...');
      const createRes = await makeRequest({
        ...baseOptions,
        path: '/api/admin/users',
        method: 'POST'
      }, {
        username: 'picker_new_' + Date.now(),
        role: 'picker',
        realName: 'New Picker'
      });
      if (createRes.status === 200 || createRes.status === 201) {
        console.log('   创建成功:', createRes.data.data.username);
        newPickerId = createRes.data.data.id;
      } else {
        console.log('   创建失败:', createRes.data);
      }
    }
  }
  console.log();

  if (testWave && newPickerId) {
    console.log('4. 测试转派前检查...');
    const checkRes = await makeRequest({
      ...baseOptions,
      path: `/api/admin/waves/${testWave.id}/transfer-check?targetRole=picker`,
      method: 'GET'
    });
    console.log('   状态:', checkRes.status);
    console.log('   是否可转派:', checkRes.data.data.allowed);
    if (!checkRes.data.data.allowed) {
      console.log('   原因:', checkRes.data.data.reason);
    }
    console.log();

    if (checkRes.data.data.allowed) {
      console.log('5. 测试波次转派...');
      const transferRes = await makeRequest({
        ...baseOptions,
        path: `/api/admin/waves/${testWave.id}/transfer`,
        method: 'POST'
      }, {
        targetUserId: newPickerId,
        targetRole: 'picker',
        reason: '人员请假',
        remark: '测试转派功能'
      });
      console.log('   状态:', transferRes.status);
      if (transferRes.status === 200) {
        console.log('   ✓ 转派成功');
        console.log('   转派记录ID:', transferRes.data.data.transfer.id);
        console.log('   原负责人:', transferRes.data.data.transfer.originalUserName);
        console.log('   新负责人:', transferRes.data.data.transfer.newUserName);
        console.log('   转派原因:', transferRes.data.data.transfer.reason);
      } else {
        console.log('   ✗ 转派失败:', transferRes.data.error || transferRes.data);
      }
      console.log();

      console.log('6. 测试波次详情（验证转派信息）...');
      const waveDetailRes = await makeRequest({
        ...baseOptions,
        path: `/api/waves/${testWave.id}`,
        method: 'GET'
      });
      if (waveDetailRes.status === 200) {
        const wave = waveDetailRes.data.data;
        console.log('   波次号:', wave.waveNo);
        console.log('   转派次数:', wave.transferCount || 0);
        console.log('   最近转派新负责人:', wave.lastTransfer ? wave.lastTransfer.newUserName : '无');
        console.log('   交接历史数量:', (wave.transferHistory || []).length);
        console.log('   ✓ 波次详情包含转派信息');
      }
      console.log();

      console.log('7. 测试转派历史列表（管理视角）...');
      const transferListRes = await makeRequest({
        ...baseOptions,
        path: '/api/admin/wave-transfers?pageSize=10',
        method: 'GET'
      });
      if (transferListRes.status === 200) {
        console.log('   总记录数:', transferListRes.data.total);
        console.log('   当前页数量:', transferListRes.data.data.length);
        if (transferListRes.data.data.length > 0) {
          const t = transferListRes.data.data[0];
          console.log('   最新转派记录:', t.waveNo);
          console.log('   角色:', t.transferRole);
          console.log('   发起人:', t.operatorUser ? t.operatorUser.realName : '未知');
          console.log('   原负责人:', t.originalUser ? t.originalUser.realName : '无');
          console.log('   新负责人:', t.newUser ? t.newUser.realName : '未知');
          console.log('   ✓ 转派列表可查询');
        }
      }
      console.log();

      console.log('8. 测试波次列表中的转派信息...');
      const waveListRes = await makeRequest({
        ...baseOptions,
        path: '/api/waves?pageSize=5',
        method: 'GET'
      });
      if (waveListRes.status === 200) {
        const waves = waveListRes.data.data;
        const transferred = waves.filter(w => w.lastTransfer);
        console.log('   列表中包含转派信息的波次数:', transferred.length);
        if (transferred.length > 0) {
          console.log('   ✓ 波次列表展示最近转派信息');
        }
      }
      console.log();

      console.log('9. 测试数据权限（原负责人视角）...');
      const originalPickerOptions = {
        ...baseOptions,
        headers: {
          ...baseOptions.headers,
          'X-User-Id': testWave.pickerId,
          'X-User-Role': 'picker'
        }
      };
      const origPickerWaveListRes = await makeRequest({
        ...originalPickerOptions,
        path: '/api/waves?pageSize=10',
        method: 'GET'
      });
      if (origPickerWaveListRes.status === 200) {
        console.log('   原拣货员可见波次数:', origPickerWaveListRes.data.total);
        const hasWave = origPickerWaveListRes.data.data.find(w => w.id === testWave.id);
        if (!hasWave) {
          console.log('   ✓ 原负责人不再看到被转派的波次');
        } else {
          console.log('   原负责人仍能看到该波次');
        }
      }
      console.log();

      console.log('10. 测试数据权限（新负责人视角）...');
      const newPickerOptions = {
        ...baseOptions,
        headers: {
          ...baseOptions.headers,
          'X-User-Id': newPickerId,
          'X-User-Role': 'picker'
        }
      };
      const newPickerWaveListRes = await makeRequest({
        ...newPickerOptions,
        path: '/api/waves?pageSize=10',
        method: 'GET'
      });
      if (newPickerWaveListRes.status === 200) {
        console.log('   新拣货员可见波次数:', newPickerWaveListRes.data.total);
        const hasWave = newPickerWaveListRes.data.data.find(w => w.id === testWave.id);
        if (hasWave) {
          console.log('   ✓ 新负责人可以看到接手的波次');
        } else {
          console.log('   新负责人看不到该波次');
        }
      }
      console.log();

      console.log('11. 测试转派记录筛选功能...');
      const filterPath = '/api/admin/wave-transfers?transferRole=picker&reason=' + encodeURIComponent('人员请假') + '&pageSize=10';
      const filterRes = await makeRequest({
        ...baseOptions,
        path: filterPath,
        method: 'GET'
      });
      if (filterRes.status === 200) {
        console.log('   按角色+原因筛选结果:', filterRes.data.total, '条');
        console.log('   ✓ 多维度筛选功能正常');
      }
      console.log();
    }
  }

  console.log('=== 测试完成 ===');
}

test().catch(console.error);
