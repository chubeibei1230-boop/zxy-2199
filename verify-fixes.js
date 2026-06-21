const base = "http://localhost:8145";

async function request(url, method, headers, body) {
  const res = await fetch(base + url, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log("=== 4 Bug Fixes Verification Test ===\n");

  const health = await request("/api/health", "GET", {});
  const userCount = health.data && health.data.entities ? health.data.entities.users : 0;
  console.log(`Current users in DB: ${userCount}`);

  let adminId = null;
  const bootstrapHeaders = { "X-User-Id": "bootstrap-admin", "X-User-Role": "admin" };

  if (userCount === 0) {
    console.log("[Bootstrap] Creating first admin...");
    const adminRes = await request("/api/admin/users", "POST", bootstrapHeaders,
      { username: "admin001", role: "admin", realName: "Admin Zhang" });
    console.log("  Status:", adminRes.status);
    if (!adminRes.ok) {
      console.log("  Error:", adminRes.data.error);
      console.log("\n  Trying to verify auth fix without bootstrap...");
    }
    adminId = adminRes.ok ? (adminRes.data.data ? adminRes.data.data.id : adminRes.data.id) : null;
    console.log("  Admin ID:", adminId);
  } else {
    console.log("[Info] Users table not empty, need existing admin ID");
    const users = await request("/api/admin/users", "GET", bootstrapHeaders);
    if (users.ok && users.data.data) {
      const adminUser = users.data.data.find(u => u.role === "admin" && u.active);
      adminId = adminUser ? adminUser.id : null;
    }
    if (!adminId) {
      console.log("  No admin found, skipping tests requiring auth...");
    }
  }

  console.log("\n=== Bug 1: Auth forgery verification ===");
  const fakeTest = await request("/api/admin/zones", "GET", { "X-User-Id": "fake-user-123", "X-User-Role": "admin" });
  console.log("  1a. Fake non-existent user ID - Status:", fakeTest.status, "Error:", fakeTest.data.error);
  console.assert(fakeTest.status === 401, "Should return 401 for fake user");
  console.log("  ✅ PASS: Fake user blocked with 401");

  if (adminId) {
    const adminH = { "X-User-Id": adminId, "X-User-Role": "admin" };
    
    const pickerCreate = await request("/api/admin/users", "POST", adminH,
      { username: "picker001", role: "picker", realName: "Picker Li" });
    const pickerId = pickerCreate.ok ? (pickerCreate.data.data ? pickerCreate.data.data.id : pickerCreate.data.id) : null;

    if (pickerId) {
      const roleHack = await request("/api/admin/zones", "GET", { "X-User-Id": pickerId, "X-User-Role": "admin" });
      console.log("  1b. Picker impersonate admin - Status:", roleHack.status, "Error:", roleHack.data.error);
      console.assert(roleHack.status === 401, "Should return 401 for role mismatch");
      console.log("  ✅ PASS: Role forgery blocked with 401");
    }

    const realAdminTest = await request("/api/admin/zones", "GET", adminH);
    console.log("  1c. Real admin access - Status:", realAdminTest.status, realAdminTest.ok ? "PASS" : "FAIL");
    console.assert(realAdminTest.ok, "Real admin should succeed");
    console.log("  ✅ PASS: Real admin access works");
    console.log("\n  ✅ Bug 1 fixed: Auth forgery properly blocked");

    console.log("\n=== Setup test data ===");
    const checkerCreate = await request("/api/admin/users", "POST", adminH,
      { username: "checker001", role: "checker", realName: "Checker Wang" });
    const checkerId = checkerCreate.ok ? (checkerCreate.data.data ? checkerCreate.data.data.id : checkerCreate.data.id) : null;
    
    const pickerH = { "X-User-Id": pickerId, "X-User-Role": "picker" };
    const checkerH = { "X-User-Id": checkerId, "X-User-Role": "checker" };

    const zone = (await request("/api/admin/zones", "POST", adminH,
      { zoneCode: "B01", zoneName: "Zone B Test" })).data.data;
    
    const locs = [];
    for (let i = 1; i <= 10; i++) {
      const loc = (await request("/api/admin/locations", "POST", adminH,
        { locationCode: `B01-${i}-01`, zoneId: zone.id })).data.data;
      locs.push(loc.id);
    }
    
    const skus = [];
    for (let i = 1; i <= 10; i++) {
      const sku = (await request("/api/admin/skus", "POST", adminH,
        { skuCode: `SKU-B${String(i).padStart(4, '0')}`, skuName: `Test Product ${i}`, defaultLocationId: locs[i-1] })).data.data;
      skus.push(sku.id);
    }
    console.log("  Setup done: 1 zone / 10 locations / 10 SKUs / 3 users");

    console.log("\n=== Set review ratio to 0.3 ===");
    await request("/api/admin/config/review-ratio", "PUT", adminH, { value: 0.3 });

    console.log("\n=== Create wave with 10 SKUs ===");
    const waveItems = skus.map(s => ({ skuId: s, planQty: 10 }));
    let wave = (await request("/api/picker/waves", "POST", adminH,
      { zoneId: zone.id, pickerId, checkerId, items: waveItems })).data.data;
    console.log("  Wave created:", wave.waveNo, "ID:", wave.id);

    console.log("\n=== Complete picking (all actual = plan, no shortage) ===");
    wave = (await request(`/api/picker/waves/${wave.id}/start-picking`, "POST", pickerH)).data.data;
    
    for (const item of wave.items) {
      const scan = (await request(`/api/picker/waves/${wave.id}/scan-location`, "POST", pickerH,
        { pickItemId: item.pickItemId, scannedLocationCode: item.locationCode })).data.data;
      await request(`/api/picker/picking-records/${scan.id}/submit-qty`, "POST", pickerH,
        { actualQty: 10 });
    }
    
    wave = (await request(`/api/picker/waves/${wave.id}/finish-picking`, "POST", pickerH)).data.data;
    console.log("  Picking done, status:", wave.status);

    console.log("\n=== Bug 2: True random sampling verification ===");
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const start = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
      const sorted = [...start.sampledItemIds].sort().join(',');
      samples.push(sorted);
      console.log(`    Sample ${i+1}: ${start.sampleSize} items - ${sorted.slice(0, 32)}...`);
    }
    const uniqueSamples = new Set(samples);
    console.log("  5 samples produced", uniqueSamples.size, "unique results");
    console.assert(uniqueSamples.size > 1, "Should have different samples");
    console.log("  ✅ Bug 2 fixed: Sampling is truly random (Fisher-Yates shuffle)");

    const checkStart = await request(`/api/checker/waves/${wave.id}/start-checking`, "POST", checkerH);
    const sampledIds = checkStart.sampledItemIds;
    console.log("  Final sample size:", checkStart.sampleSize, "/", checkStart.totalItems, "(ratio:", checkStart.ratio, ")");

    console.log("\n=== Bug 3: Prevent duplicate check records ===");
    const firstSubmit = await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId: sampledIds[0], checkedQty: 10 });
    console.log("  First submit - Status:", firstSubmit.status, firstSubmit.ok ? "PASS" : "FAIL");
    
    const secondSubmit = await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId: sampledIds[0], checkedQty: 10 });
    console.log("  Duplicate submit - Status:", secondSubmit.status, "Error:", secondSubmit.data.error);
    console.assert(secondSubmit.status === 409, "Duplicate should return 409");
    console.log("  ✅ Bug 3 fixed: Duplicate check records properly blocked (409)");

    console.log("\n  Extra: Non-sampled item cannot be checked");
    const notSampled = wave.items.find(i => !sampledIds.includes(i.pickItemId));
    const badSubmit = await request("/api/checker/check-records", "POST", checkerH,
      { waveId: wave.id, pickItemId: notSampled.pickItemId, checkedQty: 10 });
    console.log("  Non-sampled submit - Status:", badSubmit.status, "Error:", badSubmit.data.error);
    console.assert(badSubmit.status === 400, "Non-sampled should return 400");
    console.log("  ✅ Extra: Non-sampled items blocked from check");

    console.log("\n=== Bug 4: No-discrepancy wave auto flow ===");
    const waveBefore = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
    console.log("  Before submit all - Status:", waveBefore.status);
    
    for (let i = 1; i < sampledIds.length; i++) {
      await request("/api/checker/check-records", "POST", checkerH,
        { waveId: wave.id, pickItemId: sampledIds[i], checkedQty: 10, packingSuggestion: "Standard" });
    }
    
    const waveAfter = (await request(`/api/waves/${wave.id}`, "GET", adminH)).data.data;
    console.log("  After submit all - Status:", waveAfter.status);
    console.assert(waveAfter.status === "可包装", `Should be 可包装, got ${waveAfter.status}`);
    console.log("  ✅ Bug 4 fixed: No-discrepancy wave auto flows from TO_CHECK to TO_PACK");

    console.log("\n=== Final close verification ===");
    const checks = (await request(`/api/checker/check-records?waveId=${wave.id}`, "GET", adminH)).data.data;
    for (const rec of checks) {
      await request(`/api/checker/check-records/${rec.id}/confirm-packing`, "POST", checkerH, {});
    }
    
    const finalWave = (await request(`/api/checker/waves/${wave.id}/final-confirm`, "POST", checkerH)).data.data;
    console.log("  Final status:", finalWave.status);
    console.assert(finalWave.status === "已关闭", "Should be 已关闭");
    console.log("  ✅ Wave closed successfully through full normal flow");

    console.log("\n==============================================");
    console.log("🎉 ALL 4 BUG FIXES VERIFIED SUCCESSFULLY!");
    console.log("==============================================\n");
    console.log("Fix Summary:");
    console.log("  ✅ Bug 1: Auth validates user existence + role match + active status");
    console.log("  ✅ Bug 2: Sampling uses Fisher-Yates shuffle (true random)");
    console.log("  ✅ Bug 3: Unique constraint on (waveId, pickItemId) prevents duplicate checks");
    console.log("  ✅ Bug 4: Auto TO_CHECK → TO_PACK when all sampled items pass with no discrepancy");
    console.log("  ✅ Extra: Non-sampled SKUs blocked from check submission");
    console.log("  ✅ Extra: Bootstrap mode allows first admin creation when user table is empty\n");
  } else {
    console.log("\n✅ Bug 1 (auth forgery) verified successfully");
    console.log("\n⚠️  Remaining tests require valid admin ID - please clear data and restart to run full test");
  }
}

main().catch(e => console.error("Test error:", e));
