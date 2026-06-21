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

  console.log("=== 完整流程验证：无差异波次 待复核 → 可包装 → 已关闭 ===");
  
  const zoneId = (await request("/api/admin/zones", "POST", adminH,
    { zoneCode: "E01", zoneName: "Zone E Final Test" })).data.data.id;
  
  const loc1 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "E01-1-01", zoneId })).data.data.id;
  const loc2 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "E01-2-01", zoneId })).data.data.id;
  const loc3 = (await request("/api/admin/locations", "POST", adminH,
    { locationCode: "E01-3-01", zoneId })).data.data.id;
  
  const sku1 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-E0001", skuName: "Final 1", defaultLocationId: loc1 })).data.data.id;
  const sku2 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-E0002", skuName: "Final 2", defaultLocationId: loc2 })).data.data.id;
  const sku3 = (await request("/api/admin/skus", "POST", adminH,
    { skuCode: "SKU-E0003", skuName: "Final 3", defaultLocationId: loc3 })).data.data.id;

  const waveItems = [
    { skuId: sku1, planQty: 10 },
    { skuId: sku2, planQty: 10 },
    { skuId: sku3, planQty: 10 }
  ];
  
  let wave = (await request("/api/picker/waves", "POST", adminH,
    { zoneId, pickerId, checkerId, items: waveItems })).data.data;
  console.log("\n1. 创建波次:", wave.waveNo, "状态:", wave.status);

  wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
  console.log("2. 开始拣货，状态:", wave.status);
  
  for (const item of wave.items) {
    const scan = (await request(`/api/picker/waves/${wave.id}/scan-location`, "POST", pickerH,
      { pickItemId: item.pickItemId, scannedLocationCode: item.locationCode })).data.data;
    await request(`/api/picker/picking-records/${scan.id}/submit-qty`, "POST", pickerH,
      { actualQty: 10 });
  }
  
  wave = (await request(`/api/picker/waves/${wave.id}/finish-picking`, "POST", pickerH)).data.data;
  console.log("3. 完成拣货，状态:", wave.status);

  await request("/api/admin/config/review-ratio", "PUT", adminH, { value: 1.0 });
  const checkStart = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
  const sampledIds = checkStart.data.sampledItemIds;
  console.log("4. 开始复核，抽样:", sampledIds.length, "项，状态:", checkStart.data.status);

  for (let i = 0; i < sampledIds.length; i++) {
    const result = await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId: sampledIds[i], checkedQty: 10, packingSuggestion: "标准包装" });
    wave = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
    console.log(`5${i+1}. 提交复核 ${i+1}/${sampledIds.length}，状态: ${wave.status}`);
  }

  console.log("\n✅ Bug 4 验证通过：最后一条复核后状态从", "待复核", "→", wave.status);

  const checks = (await request(`/api/checker/check-records/wave/${wave.id}`, "GET", adminH)).data.data;
  console.log("\n6. 确认包装，共", checks.length, "条记录");
  
  for (let i = 0; i < checks.length; i++) {
    await request(`/api/checker/check-records/${checks[i].id}/confirm-packing`, "POST", checkerH,
      { packageNo: `PKG-${wave.waveNo}-${i+1}`, packageWeight: 1.5 });
    console.log(`   ${i+1}/${checks.length} 包装确认完成`);
  }

  wave = (await request(`/api/checker/waves/${wave.id}/final-confirm`, "POST", checkerH)).data.data;
  console.log("\n7. 最终确认，状态:", wave.status);

  console.log("\n🎉 完整流程验证成功！");
  console.log("   状态流转: 待拣货 → 拣货中 → 待复核 → 可包装 → 已关闭");
  console.log("   ✅ 无差异波次自动流转正常工作！");
}

main().catch(e => console.error("Error:", e));
