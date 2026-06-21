const base = "http://localhost:8145";

async function request(url, method, headers, body) {
  const res = await fetch(base + url, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  console.log(`\n=== 测试: ${name} ===`);
  try {
    fn();
    console.log(`✅ ${name} - 通过`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name} - 失败:`, e.message);
    failed++;
  }
}

async function testAsync(name, fn) {
  console.log(`\n=== 测试: ${name} ===`);
  try {
    await fn();
    console.log(`✅ ${name} - 通过`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name} - 失败:`, e.message);
    failed++;
  }
}

async function main() {
  console.log("=" * 60);
  console.log("波次挂起与恢复功能测试");
  console.log("=" * 60);

  const adminId = "0e1c91842e104e9e8a777ab0685c17a5";
  const adminH = { "X-User-Id": adminId, "X-User-Role": "admin" };
  
  const users = (await request("/api/admin/users", "GET", adminH)).data.data;
  const pickerId = users.find(u => u.username === "picker001").id;
  const checkerId = users.find(u => u.username === "checker001").id;
  const pickerH = { "X-User-Id": pickerId, "X-User-Role": "picker" };
  const checkerH = { "X-User-Id": checkerId, "X-User-Role": "checker" };

  console.log("\n管理员ID:", adminId);
  console.log("拣货员ID:", pickerId);
  console.log("复核员ID:", checkerId);

  const timestamp = Date.now().toString().slice(-6);
  const zoneId = (await request("/api/admin/zones", "POST", adminH,
    { zoneCode: "SUS" + timestamp, zoneName: "Suspension Test Zone " + timestamp })).data.data.id;
  
  const loc1 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "SUS-" + timestamp + "-01", zoneId })).data.data.id;
  const loc2 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "SUS-" + timestamp + "-02", zoneId })).data.data.id;
  
  const sku1 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-SUS" + timestamp + "1", skuName: "Suspension Test 1", defaultLocationId: loc1 })).data.data.id;
  const sku2 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-SUS" + timestamp + "2", skuName: "Suspension Test 2", defaultLocationId: loc2 })).data.data.id;

  const waveItems = [
    { skuId: sku1, planQty: 10 },
    { skuId: sku2, planQty: 10 }
  ];

  await testAsync("1. 获取挂起原因枚举", async () => {
    const res = await request("/api/admin/suspension-reasons", "GET", adminH);
    if (!res.ok) throw new Error("获取失败: " + JSON.stringify(res.data));
    if (!Array.isArray(res.data.data)) throw new Error("返回数据不是数组");
    console.log("   挂起原因:", res.data.data);
    if (res.data.data.length < 5) throw new Error("挂起原因数量不足");
  });

  await testAsync("2. 创建波次并开始拣货", async () => {
    let wave = (await request("/api/picker/waves", "POST", adminH,
      { zoneId, pickerId, checkerId, items: waveItems })).data.data;
    console.log("   创建波次:", wave.waveNo, "状态:", wave.status);
    
    wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
    console.log("   开始拣货，状态:", wave.status);
    
    global.testWaveId = wave.id;
    
    if (wave.status !== "拣货中") throw new Error("状态应该是拣货中");
    if (wave.isSuspended !== undefined && wave.isSuspended !== false) {
      throw new Error("初始状态不应挂起");
    }
  });

  await testAsync("3. 管理员挂起波次 - 成功", async () => {
    const expectedResume = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await request(`/api/admin/waves/${global.testWaveId}/suspend`, "POST", adminH, {
      reason: "设备故障",
      responsiblePerson: "张三",
      remark: "测试挂起功能",
      expectedResumeAt: expectedResume
    });
    if (!res.ok) throw new Error("挂起失败: " + JSON.stringify(res.data));
    console.log("   挂起结果:", res.data.data.wave.status, "isSuspended:", res.data.data.wave.isSuspended);
    console.log("   挂起记录ID:", res.data.data.suspension.id);
    
    if (!res.data.data.wave.isSuspended) throw new Error("波次应该已挂起");
    if (res.data.data.suspension.reason !== "设备故障") throw new Error("挂起原因不匹配");
    if (res.data.data.suspension.responsiblePerson !== "张三") throw new Error("责任人不匹配");
    global.suspensionId = res.data.data.suspension.id;
  });

  await testAsync("4. 挂起后无法继续拣货扫描", async () => {
    const wave = (await request(`/api/waves/${global.testWaveId}`, "GET", adminH)).data.data;
    const firstItem = wave.items[0];
    
    const res = await request(`/api/picker/waves/${global.testWaveId}/scan-location`, "POST", pickerH, {
      pickItemId: firstItem.pickItemId,
      scannedLocationCode: firstItem.locationCode
    });
    
    if (res.ok) throw new Error("挂起状态下应该不能扫描拣货");
    console.log("   拒绝原因:", res.data.error);
    if (!res.data.error.includes("挂起")) throw new Error("错误信息应该包含挂起");
  });

  await testAsync("5. 挂起后无法完成拣货", async () => {
    const res = await request(`/api/picker/waves/${global.testWaveId}/finish-picking`, "POST", pickerH);
    if (res.ok) throw new Error("挂起状态下应该不能完成拣货");
    console.log("   拒绝原因:", res.data.error);
  });

  await testAsync("6. 查看波次详情 - 包含挂起信息", async () => {
    const res = await request(`/api/waves/${global.testWaveId}`, "GET", adminH);
    if (!res.ok) throw new Error("获取详情失败");
    const wave = res.data.data;
    console.log("   isSuspended:", wave.isSuspended);
    console.log("   activeSuspension原因:", wave.activeSuspension?.reason);
    console.log("   suspensionTimeline条数:", wave.suspensionTimeline?.length);
    
    if (!wave.isSuspended) throw new Error("详情应该显示挂起状态");
    if (!wave.activeSuspension) throw new Error("应该有当前挂起信息");
    if (!wave.suspensionTimeline || wave.suspensionTimeline.length < 1) {
      throw new Error("应该有挂起时间线");
    }
  });

  await testAsync("7. 波次列表 - 支持按挂起状态筛选", async () => {
    const res = await request(`/api/waves?isSuspended=true`, "GET", adminH);
    if (!res.ok) throw new Error("查询失败");
    console.log("   挂起中的波次数:", res.data.total);
    const hasTargetWave = res.data.data.some(w => w.id === global.testWaveId);
    if (!hasTargetWave) throw new Error("筛选结果应该包含测试波次");
    
    const res2 = await request(`/api/waves?isSuspended=false`, "GET", adminH);
    const hasTargetWave2 = res2.data.data.some(w => w.id === global.testWaveId);
    if (hasTargetWave2) throw new Error("未挂起筛选结果不应该包含测试波次");
  });

  await testAsync("8. 挂起记录列表查询", async () => {
    const res = await request("/api/wave-suspensions?status=挂起中", "GET", adminH);
    if (!res.ok) throw new Error("查询失败");
    console.log("   挂起中记录数:", res.data.total);
    if (res.data.total < 1) throw new Error("应该至少有一条挂起记录");
    
    const res2 = await request(`/api/wave-suspensions?waveId=${global.testWaveId}`, "GET", adminH);
    if (res2.data.total < 1) throw new Error("按波次查询应该有结果");
  });

  await testAsync("9. 拣货员不能挂起待复核状态的波次（无权限）", async () => {
    let wave9 = (await request("/api/picker/waves", "POST", adminH,
      { zoneId, pickerId, checkerId, items: waveItems })).data.data;
    wave9 = (await request(`/api/picker/waves/${wave9.id}/start-picking`, "POST", pickerH)).data.data;
    
    for (const item of wave9.items) {
      const scanRes = await request(`/api/picker/waves/${wave9.id}/scan-location`, "POST", pickerH, {
        pickItemId: item.pickItemId,
        scannedLocationCode: item.locationCode
      });
      await request(`/api/picker/picking-records/${scanRes.data.data.id}/submit-qty`, "POST", pickerH, {
        actualQty: item.planQty
      });
    }
    
    wave9 = (await request(`/api/picker/waves/${wave9.id}/finish-picking`, "POST", pickerH)).data.data;
    
    const res = await request(`/api/picker/waves/${wave9.id}/suspend`, "POST", pickerH, {
      reason: "设备故障",
      responsiblePerson: "测试责任人",
      remark: "测试备注",
      expectedResumeAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    });
    
    if (res.ok) throw new Error("拣货员不应该能挂起待复核状态的波次");
    console.log("   拒绝原因:", res.data.error);
  });

  await testAsync("10. 管理员恢复波次 - 成功", async () => {
    const res = await request(`/api/admin/waves/${global.testWaveId}/resume`, "POST", adminH, {
      resumeRemark: "问题已解决，恢复作业"
    });
    if (!res.ok) throw new Error("恢复失败: " + JSON.stringify(res.data));
    console.log("   恢复后状态:", res.data.data.wave.status, "isSuspended:", res.data.data.wave.isSuspended);
    console.log("   挂起时长(分钟):", res.data.data.suspension.suspensionDurationMinutes);
    
    if (res.data.data.wave.isSuspended) throw new Error("波次应该已恢复");
    if (res.data.data.suspension.status !== "已恢复") throw new Error("挂起状态应该是已恢复");
  });

  await testAsync("11. 恢复后可以继续拣货", async () => {
    const wave = (await request(`/api/waves/${global.testWaveId}`, "GET", adminH)).data.data;
    const firstItem = wave.items[0];
    
    const scanRes = await request(`/api/picker/waves/${global.testWaveId}/scan-location`, "POST", pickerH, {
      pickItemId: firstItem.pickItemId,
      scannedLocationCode: firstItem.locationCode
    });
    if (!scanRes.ok) throw new Error("恢复后应该可以扫描拣货: " + JSON.stringify(scanRes.data));
    console.log("   扫描成功:", scanRes.data.data.id);
    
    await request(`/api/picker/picking-records/${scanRes.data.data.id}/submit-qty`, "POST", pickerH, {
      actualQty: 10
    });
    
    const secondItem = wave.items[1];
    const scanRes2 = await request(`/api/picker/waves/${global.testWaveId}/scan-location`, "POST", pickerH, {
      pickItemId: secondItem.pickItemId,
      scannedLocationCode: secondItem.locationCode
    });
    await request(`/api/picker/picking-records/${scanRes2.data.data.id}/submit-qty`, "POST", pickerH, {
      actualQty: 10
    });
    
    const finishRes = await request(`/api/picker/waves/${global.testWaveId}/finish-picking`, "POST", pickerH);
    if (!finishRes.ok) throw new Error("恢复后应该可以完成拣货: " + JSON.stringify(finishRes.data));
    console.log("   完成拣货，状态:", finishRes.data.data.status);
  });

  await testAsync("12. 挂起统计汇总", async () => {
    const res = await request("/api/stats/suspension-summary", "GET", adminH);
    if (!res.ok) throw new Error("获取统计失败: " + JSON.stringify(res.data));
    console.log("   总挂起次数:", res.data.data.totalSuspensions);
    console.log("   进行中:", res.data.data.activeSuspensions);
    console.log("   已恢复:", res.data.data.resumedSuspensions);
    console.log("   原因分布:", res.data.data.reasonBreakdown);
    
    if (res.data.data.totalSuspensions < 1) throw new Error("应该至少有1次挂起");
    if (res.data.data.resumedSuspensions < 1) throw new Error("应该至少有1次已恢复");
  });

  await testAsync("13. 拣货员挂起自己的波次", async () => {
    let wave = (await request("/api/picker/waves", "POST", adminH,
      { zoneId, pickerId, checkerId, items: waveItems })).data.data;
    
    wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
    console.log("   创建新波次并开始拣货:", wave.waveNo);
    
    const res = await request(`/api/picker/waves/${wave.id}/suspend`, "POST", pickerH, {
      reason: "人员不足",
      responsiblePerson: "拣货组长",
      remark: "拣货员主动挂起",
      expectedResumeAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    });
    if (!res.ok) throw new Error("拣货员应该能挂起自己的波次: " + JSON.stringify(res.data));
    console.log("   拣货员挂起成功，状态:", res.data.data.wave.isSuspended);
    
    if (!res.data.data.wave.isSuspended) throw new Error("波次应该已挂起");
    global.pickerWaveId = wave.id;
  });

  await testAsync("14. 拣货员恢复自己挂起的波次", async () => {
    const res = await request(`/api/picker/waves/${global.pickerWaveId}/resume`, "POST", pickerH, {
      resumeRemark: "人员已到位，恢复作业"
    });
    if (!res.ok) throw new Error("拣货员应该能恢复自己挂起的波次: " + JSON.stringify(res.data));
    console.log("   拣货员恢复成功，状态:", res.data.data.wave.isSuspended);
    
    if (res.data.data.wave.isSuspended) throw new Error("波次应该已恢复");
  });

  await testAsync("15. 复核员挂起待复核波次", async () => {
    let wave = (await request("/api/picker/waves", "POST", adminH,
      { zoneId, pickerId, checkerId, items: waveItems })).data.data;
    
    wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
    
    for (const item of wave.items) {
      const scan = (await request(`/api/picker/waves/${wave.id}/scan-location`, "POST", pickerH,
        { pickItemId: item.pickItemId, scannedLocationCode: item.locationCode })).data.data;
      await request(`/api/picker/picking-records/${scan.id}/submit-qty`, "POST", pickerH,
        { actualQty: 10 });
    }
    
    wave = (await request(`/api/picker/waves/${wave.id}/finish-picking`, "POST", pickerH)).data.data;
    console.log("   创建波次并完成拣货:", wave.waveNo, "状态:", wave.status);
    
    const res = await request(`/api/checker/waves/${wave.id}/suspend`, "POST", checkerH, {
      reason: "系统问题",
      responsiblePerson: "复核组长",
      remark: "复核员主动挂起",
      expectedResumeAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    });
    if (!res.ok) throw new Error("复核员应该能挂起待复核波次: " + JSON.stringify(res.data));
    console.log("   复核员挂起成功，状态:", res.data.data.wave.isSuspended);
    
    global.checkerWaveId = wave.id;
  });

  await testAsync("16. 挂起后无法开始复核", async () => {
    const res = await request(`/api/checker/waves/${global.checkerWaveId}/start-checking`, "POST", checkerH);
    if (res.ok) throw new Error("挂起状态下应该不能开始复核");
    console.log("   拒绝原因:", res.data.error);
  });

  await testAsync("17. 复核员恢复波次", async () => {
    const res = await request(`/api/checker/waves/${global.checkerWaveId}/resume`, "POST", checkerH, {
      resumeRemark: "系统已恢复"
    });
    if (!res.ok) throw new Error("复核员应该能恢复波次: " + JSON.stringify(res.data));
    console.log("   复核员恢复成功");
  });

  await testAsync("18. 挂起超时异常提醒查询", async () => {
    const res = await request("/api/stats/suspension-timeouts", "GET", adminH);
    if (!res.ok) throw new Error("查询超时列表失败: " + JSON.stringify(res.data));
    console.log("   挂起超时数量:", res.data.total);
    console.log("   超时阈值(分钟):", res.data.timeoutThreshold);
  });

  await testAsync("19. 健康检查 - 包含挂起统计", async () => {
    const res = await request("/api/health", "GET", {});
    if (!res.ok) throw new Error("健康检查失败");
    console.log("   waveSuspensions实体数:", res.data.entities.waveSuspensions);
  });

  await testAsync("20. 挂起时间线 - 多次挂起恢复", async () => {
    let wave = (await request("/api/picker/waves", "POST", adminH,
      { zoneId, pickerId, checkerId, items: waveItems })).data.data;
    
    wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
    
    await request(`/api/admin/waves/${wave.id}/suspend`, "POST", adminH, {
      reason: "现场异常",
      responsiblePerson: "主管A",
      remark: "第一次挂起测试",
      expectedResumeAt: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString()
    });
    
    await request(`/api/admin/waves/${wave.id}/resume`, "POST", adminH, {
      resumeRemark: "第一次恢复"
    });
    
    await request(`/api/admin/waves/${wave.id}/suspend`, "POST", adminH, {
      reason: "设备故障",
      responsiblePerson: "主管B",
      remark: "第二次挂起测试",
      expectedResumeAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString()
    });
    
    await request(`/api/admin/waves/${wave.id}/resume`, "POST", adminH, {
      resumeRemark: "第二次恢复"
    });
    
    const res = await request(`/api/waves/${wave.id}/suspension-timeline`, "GET", adminH);
    if (!res.ok) throw new Error("获取时间线失败");
    
    console.log("   时间线条数:", res.data.data.timeline.length);
    console.log("   当前挂起状态:", res.data.data.activeSuspension?.status);
    
    if (res.data.data.timeline.length < 4) throw new Error("时间线应该至少有4条记录（2次挂起+2次恢复）");
  });

  console.log("\n" + "=".repeat(60));
  console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
  console.log("=".repeat(60));
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error("测试执行出错:", e);
  process.exit(1);
});
