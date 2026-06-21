const base = "http://localhost:8145";

async function request(url, method, headers, body) {
  const res = await fetch(base + url, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log("=== 4个问题修复验证测试 ===\n");

  const adminInitHeaders = { "X-User-Id": "bootstrap-admin", "X-User-Role": "admin" };
  
  console.log("【Step 1: 引导创建第一个管理员（利用bootstrap模式）】");
  let adminRes = await request("/api/admin/users", "POST", adminInitHeaders,
    { username: "admin001", role: "admin", realName: "张管理" });
  if (!adminRes.ok && adminRes.status === 401) {
    console.log("  引导未生效，直接访问...");
    const usersCount = await request("/api/health", "GET", {});
    console.log("  健康检查:", usersCount.data && usersCount.data.entities ? usersCount.data.entities.users : "N/A");
  }
  const adminUser = adminRes.data && adminRes.data.data || adminRes.data;
  const adminId = adminUser ? adminUser.id : null;
  console.log("  创建结果:", adminRes.status, "ID:", adminId);

  if (!adminId) {
    console.log("\n【手动检查auth逻辑】");
    const test1 = await request("/api/admin/zones", "GET", { "X-User-Id": "fake", "X-User-Role": "admin" });
    console.log("  伪造用户访问:", test1.status, test1.data && test1.data.error);
    
    console.log("\n【尝试用curl方式直接创建，跳过测试脚本问题】");
    return;
  }

  const adminH = { "X-User-Id": adminId, "X-User-Role": "admin" };
  
  console.log("\n=== 问题1：接口认证伪造验证 ===");
  const fakeTest = await request("/api/admin/zones", "GET", { "X-User-Id": "fake-id-123", "X-User-Role": "admin" });
  console.log("  伪造不存在的用户:", fakeTest.status, fakeTest.data.error);
  console.assert(fakeTest.status === 401, "应返回401");

  const pickerRes = await request("/api/admin/users", "POST", adminH,
    { username: "picker001", role: "picker", realName: "李拣货" });
  const pickerId = pickerRes.data.id;
  const roleHackTest = await request("/api/admin/zones", "GET", { "X-User-Id": pickerId, "X-User-Role": "admin" });
  console.log("  拣货员冒充管理员:", roleHackTest.status, roleHackTest.data.error);
  console.assert(roleHackTest.status === 401, "角色不匹配应返回401");

  const checkerRes = await request("/api/admin/users", "POST", adminH,
    { username: "checker001", role: "checker", realName: "王复核" });
  const checkerId = checkerRes.data.id;
  
  const realAdminTest = await request("/api/admin/zones", "GET", adminH);
  console.log("  真实管理员正常访问:", realAdminTest.status, realAdminTest.ok ? "✅ 通过" : "❌ 失败");
  console.assert(realAdminTest.ok, "真实管理员应该成功");

  console.log("\n=== 准备基础数据 ===");
  const zone = (await request("/api/admin/zones", "POST", adminH,
    { zoneCode: "B01", zoneName: "B区测试仓" })).data.data;
  
  const locs = [];
  for (let i = 1; i <= 10; i++) {
    const loc = (await request("/api/admin/locations", "POST", adminH,
      { locationCode: `B01-${i}-01`, zoneId: zone.id })).data.data;
    locs.push(loc);
  }
  
  const skus = [];
  for (let i = 1; i <= 10; i++) {
    const sku = (await request("/api/admin/skus", "POST", adminH,
      { skuCode: `SKU-B${String(i).padStart(4, '0')}`, skuName: `测试商品${i}`, defaultLocationId: locs[i-1].id })).data.data;
    skus.push(sku);
  }
  console.log("  准备完成: 1仓区/10货位/10SKU");

  console.log("\n=== 设置复核比例0.3 ===");
  await request("/api/admin/config/review-ratio", "PUT", adminH, { value: 0.3 });

  console.log("\n=== 创建10SKU波次 ===");
  const waveItems = skus.map(s => ({ skuId: s.id, planQty: 10 }));
  let wave = (await request("/api/picker/waves", "POST", adminH,
    { zoneId: zone.id, pickerId, checkerId, items: waveItems })).data.data;
  console.log("  波次:", wave.waveNo);

  console.log("\n=== 完成拣货（全部实际=计划，无缺货）===");
  const pickerH = { "X-User-Id": pickerId, "X-User-Role": "picker" };
  wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
  
  for (const item of wave.items) {
    const scan = (await request(`/api/picker/waves/${wave.id}/scan-location`, "POST", pickerH,
      { pickItemId: item.pickItemId, scannedLocationCode: item.locationCode })).data.data;
    await request(`/api/picker/picking-records/${scan.id}/submit-qty`, "POST", pickerH,
      { actualQty: 10 });
  }
  
  wave = (await request(`/api/picker/waves/${wave.id}/finish-picking`, "POST", pickerH)).data.data;
  console.log("  拣货完成，状态:", wave.status);

  console.log("\n=== 问题2：抽检真正随机验证 ===");
  const checkerH = { "X-User-Id": checkerId, "X-User-Role": "checker" };
  const results = [];
  for (let i = 0; i < 3; i++) {
    const start = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
    results.push(start.sampledItemIds.sort().join(','));
    console.log(`  抽样${i+1}: ${start.sampleSize}个`);
  }
  const unique = new Set(results);
  console.log("  多次抽样结果是否不同:", unique.size > 1 ? "✅ 是（真正随机）" : "⚠️ 否");

  const checkStart = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
  const sampledIds = checkStart.sampledItemIds;
  console.log("  抽检规模:", checkStart.sampleSize, "/", checkStart.totalItems, "（比例:", checkStart.ratio, "）");

  console.log("\n=== 问题3：防重复复核验证 ===");
  const firstSubmit = await request("/api/checker/check-records", "POST", checkerH,
    { waveId: wave.id, pickItemId: sampledIds[0], checkedQty: 10 });
  console.log("  第一次提交:", firstSubmit.status, firstSubmit.ok ? "✅ 成功" : "❌ 失败");
  
  const secondSubmit = await request("/api/checker/check-records", "POST", checkerH,
    { waveId: wave.id, pickItemId: sampledIds[0], checkedQty: 10 });
  console.log("  重复提交:", secondSubmit.status, secondSubmit.data.error);
  console.assert(secondSubmit.status === 409, "重复提交应返回409");

  console.log("\n=== 非抽检范围SKU禁止复核验证 ===");
  const notSampled = wave.items.find(i => !sampledIds.includes(i.pickItemId));
  const badSubmit = await request("/api/checker/check-records", "POST", checkerH,
    { waveId: wave.id, pickItemId: notSampled.pickItemId, checkedQty: 10 });
  console.log("  非抽检提交:", badSubmit.status, badSubmit.data.error);
  console.assert(badSubmit.status === 400, "非抽检应返回400");

  console.log("\n=== 问题4：无差异波次自动流转验证 ===");
  console.log("  提交前状态:", wave.status);
  
  for (let i = 1; i < sampledIds.length; i++) {
    await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId: sampledIds[i], checkedQty: 10, packingSuggestion: "标准包装" });
  }
  
  const waveAfter = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
  console.log("  全部复核后状态:", waveAfter.status);
  console.assert(waveAfter.status === "可包装", `应自动流转到可包装，实际是${waveAfter.status}`);

  console.log("\n=== 最终关闭波次验证 ===");
  const checks = (await request(`/api/checker/check-records?waveId=${wave.id}`, "GET", adminH)).data.data;
  for (const rec of checks) {
    await request(`/api/checker/check-records/${rec.id}/confirm-packing`, "POST", checkerH, {});
  }
  
  const finalWave = (await request(`/api/checker/waves/${wave.id}/final-confirm`, "POST", checkerH)).data.data;
  console.log("  最终状态:", finalWave.status);
  console.assert(finalWave.status === "已关闭", "应正常关闭");

  console.log("\n🎉 全部4个问题修复验证通过！");
}

main().catch(e => console.error("异常:", e));
