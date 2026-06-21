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

async function main() {
  const adminId = "0e1c91842e104e9e8a777ab0685c17a5";
  const adminH = { "X-User-Id": adminId, "X-User-Role": "admin" };
  
  const users = (await request("/api/admin/users", "GET", adminH)).data.data;
  const pickerId = users.find(u => u.username === "picker001").id;
  const checkerId = users.find(u => u.username === "checker001").id;
  const pickerH = { "X-User-Id": pickerId, "X-User-Role": "picker" };
  const checkerH = { "X-User-Id": checkerId, "X-User-Role": "checker" };

  console.log("=== Bug 4 专项测试：无差异波次自动流转 ===");
  console.log("\n【准备】创建新的测试波次（3个SKU）");
  
  const zoneId = (await request("/api/admin/zones", "POST", adminH,
    { zoneCode: "D01", zoneName: "Zone D Bug4 Final Test" })).data.data.id;
  
  const loc1 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "D01-1-01", zoneId })).data.data.id;
  const loc2 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "D01-2-01", zoneId })).data.data.id;
  const loc3 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "D01-3-01", zoneId })).data.data.id;
  
  const sku1 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-D0001", skuName: "Bug4 Test 1", defaultLocationId: loc1 })).data.data.id;
  const sku2 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-D0002", skuName: "Bug4 Test 2", defaultLocationId: loc2 })).data.data.id;
  const sku3 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-D0003", skuName: "Bug4 Test 3", defaultLocationId: loc3 })).data.data.id;

  const waveItems = [
    { skuId: sku1, planQty: 10 },
    { skuId: sku2, planQty: 10 },
    { skuId: sku3, planQty: 10 }
  ];
  
  let wave = (await request("/api/picker/waves", "POST", adminH,
    { zoneId, pickerId, checkerId, items: waveItems })).data.data;
  console.log("  波次创建:", wave.waveNo, "ID:", wave.id);

  console.log("\n【Step 1】完成拣货（全部实际=计划，无差异）");
  wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
  
  for (const item of wave.items) {
    const scan = (await request(`/api/picker/waves/${wave.id}/scan-location`, "POST", pickerH,
      { pickItemId: item.pickItemId, scannedLocationCode: item.locationCode })).data.data;
    await request(`/api/picker/picking-records/${scan.id}/submit-qty`, "POST", pickerH,
      { actualQty: 10 });
  }
  
  wave = (await request(`/api/picker/waves/${wave.id}/finish-picking`, "POST", pickerH)).data.data;
  console.log("  拣货完成，状态:", wave.status);

  console.log("\n【Step 2】开始复核（比例100%）");
  await request("/api/admin/config/review-ratio", "PUT", adminH, { value: 1.0 });
  const checkStart = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
  const sampledIds = checkStart.data.sampledItemIds;
  console.log("  抽样数量:", checkStart.data.sampleSize, "/", checkStart.data.totalItems);
  console.log("  抽样列表长度:", sampledIds.length);

  console.log("\n【Step 3】逐条提交复核（全部无差异，使用中文枚举值）");
  
  wave = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
  console.log("  当前波次状态:", wave.status);
  console.log("  波次.reviewSampledItemIds:", wave.reviewSampledItemIds ? wave.reviewSampledItemIds.length : "undefined");
  
  for (let i = 0; i < sampledIds.length; i++) {
    const pickItemId = sampledIds[i];
    wave = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
    console.log(`\n  提交第 ${i+1}/${sampledIds.length} 条前，状态: ${wave.status}`);
    
    const submit = await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId, checkedQty: 10, packingSuggestion: "标准包装" });
    
    if (!submit.ok) {
      console.log(`    ❌ 提交失败: ${submit.status} - ${submit.data.error}`);
      return;
    }
    
    console.log(`    ✅ 提交成功: ${submit.status}`);
    
    wave = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
    console.log(`  提交后状态: ${wave.status}`);
  }

  console.log("\n【结果检查】");
  const checks = (await request(`/api/checker/check-records?waveId=${wave.id}`, "GET", adminH)).data.data;
  console.log("  已提交复核记录数:", checks.length);
  console.log("  每条详情:");
  checks.forEach((c, idx) => {
    const inSample = wave.reviewSampledItemIds.includes(c.pickItemId);
    console.log(`    ${idx+1}: pickItemId=${c.pickItemId.slice(0,8)}..., inSample=${inSample}, hasDiscrepancy=${c.hasDiscrepancy}, resolved=${c.discrepancyResolved}`);
  });

  console.log("\n  检查自动流转条件:");
  const allInSample = checks.filter(c => wave.reviewSampledItemIds.includes(c.pickItemId));
  const allCompleted = allInSample.length >= wave.reviewSampledItemIds.length;
  const allPass = checks.every(c => !c.hasDiscrepancy || c.discrepancyResolved);
  console.log(`    已提交抽样数 (${allInSample.length}) >= 需抽样数 (${wave.reviewSampledItemIds.length}): ${allCompleted}`);
  console.log(`    所有复核记录无差异或已解决: ${allPass}`);
  console.log(`    当前状态是TO_CHECK: ${wave.status === "待复核"}`);
  console.log(`    综合条件: ${allCompleted && allPass && wave.status === "待复核"}`);

  if (wave.status === "可包装") {
    console.log("\n🎉 ✅ Bug 4 FIX VERIFIED! 无差异波次自动流转到'可包装'");
  } else {
    console.log("\n❌ Bug 4 仍存在，状态未流转。检查代码逻辑...");
    console.log("\n  代码中的条件:");
    console.log("    allCompleted = completedChecks.length >= sampledNeedCheck.length");
    console.log("    allPass = allChecks.every(c => !c.hasDiscrepancy || c.discrepancyResolved)");
    console.log("    if (allCompleted && allPass && wave.status === WAVE_STATUS.TO_CHECK)");
    console.log("      wavesStore.update(waveId, { status: WAVE_STATUS.TO_PACK })");
    console.log("\n  问题可能在于: wave 对象是在函数开头获取的，其 status 是提交前的状态");
    console.log("  但实际上 wave.status 还是 待复核，应该是可以流转的...");
  }
}

main().catch(e => console.error("Error:", e));
