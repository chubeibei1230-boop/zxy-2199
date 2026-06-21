$base = "http://localhost:8145"
$ErrorActionPreference = "Stop"

function req($method, $url, $headers, $body) {
    try {
        $params = @{
            Uri = "$base$url"
            Method = $method
            Headers = $headers
            ErrorAction = "Stop"
        }
        if ($body) {
            $params.Body = ($body | ConvertTo-Json -Depth 10)
            $params.ContentType = "application/json"
        }
        $r = Invoke-RestMethod @params
        return [pscustomobject]@{ status = 200; ok = $true; data = $r.data }
    } catch {
        $resp = $_.Exception.Response
        $status = [int]$resp.StatusCode
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $reader.BaseStream.Position = 0
        $errBody = $reader.ReadToEnd()
        try { $errObj = $errBody | ConvertFrom-Json } catch { $errObj = [pscustomobject]@{ error = $errBody } }
        return [pscustomobject]@{ status = $status; ok = $false; data = $errObj; error = $errObj.error }
    }
}

Write-Host "`n=== 4个问题修复验证测试 ===`n" -ForegroundColor Cyan

Write-Host "【1. 引导创建第一个管理员（用户表空时允许创建）】" -ForegroundColor Yellow
$adminHeaders = @{ "X-User-Id" = "boot-admin"; "X-User-Role" = "admin" }
$r = req POST "/api/admin/users" $adminHeaders @{ username = "admin001"; role = "admin"; realName = "张管理" }
Write-Host "  状态: $($r.status)"
if (-not $r.ok) { Write-Host "  错误: $($r.error)" -ForegroundColor Red; exit 1 }
$adminId = $r.data.id
Write-Host "  管理员ID: $adminId" -ForegroundColor Green

$adminH = @{ "X-User-Id" = $adminId; "X-User-Role" = "admin" }

Write-Host "`n=== 问题1：接口认证可以伪造 验证 ===" -ForegroundColor Yellow

Write-Host "`n  测试1a: 伪造不存在的用户ID"
$r = req GET "/api/admin/zones" @{ "X-User-Id" = "fake-user-123"; "X-User-Role" = "admin" }
Write-Host "    请求状态: $($r.status), 错误: $($r.error)"
if ($r.status -ne 401) { Write-Host "    ❌ 失败：应该返回401" -ForegroundColor Red; exit 1 }
Write-Host "    ✅ 通过：正确拦截伪造用户" -ForegroundColor Green

Write-Host "`n  测试1b: 角色不匹配（拣货员冒充管理员）"
$pickerCreate = req POST "/api/admin/users" $adminH @{ username = "picker001"; role = "picker"; realName = "李拣货" }
$pickerId = $pickerCreate.data.id
$r = req GET "/api/admin/zones" @{ "X-User-Id" = $pickerId; "X-User-Role" = "admin" }
Write-Host "    请求状态: $($r.status), 错误: $($r.error)"
if ($r.status -ne 401) { Write-Host "    ❌ 失败：应该返回401" -ForegroundColor Red; exit 1 }
Write-Host "    ✅ 通过：正确拦截角色伪造" -ForegroundColor Green

Write-Host "`n  测试1c: 真实管理员正常访问"
$r = req GET "/api/admin/zones" $adminH
Write-Host "    请求状态: $($r.status)"
if (-not $r.ok) { Write-Host "    ❌ 失败: $($r.error)" -ForegroundColor Red; exit 1 }
Write-Host "    ✅ 通过：真实用户访问成功" -ForegroundColor Green

Write-Host "`n=== 准备基础数据 ===" -ForegroundColor Yellow
$checkerId = (req POST "/api/admin/users" $adminH @{ username = "checker001"; role = "checker"; realName = "王复核" }).data.id
$zoneId = (req POST "/api/admin/zones" $adminH @{ zoneCode = "B01"; zoneName = "B区测试仓" }).data.id
$locs = @()
for ($i = 1; $i -le 10; $i++) {
    $locId = (req POST "/api/admin/locations" $adminH @{ locationCode = "B01-$i-01"; zoneId = $zoneId }).data.id
    $locs += $locId
}
$skus = @()
for ($i = 1; $i -le 10; $i++) {
    $skuId = (req POST "/api/admin/skus" $adminH @{ skuCode = "SKU-B$($i.ToString().PadLeft(4,'0'))"; skuName = "测试商品$i"; defaultLocationId = $locs[$i-1] }).data.id
    $skus += $skuId
}
Write-Host "  准备完成：1仓区/10货位/10SKU" -ForegroundColor Green

Write-Host "`n=== 设置复核比例为0.3 ===" -ForegroundColor Yellow
req PUT "/api/admin/config/review-ratio" $adminH @{ value = 0.3 } | Out-Null
$ratio = (req GET "/api/admin/config/review-ratio" $adminH).data.value
Write-Host "  当前复核比例: $ratio" -ForegroundColor Green

Write-Host "`n=== 创建波次（10个SKU）===" -ForegroundColor Yellow
$waveItems = $skus | ForEach-Object { @{ skuId = $_; planQty = 10 } }
$waveId = (req POST "/api/picker/waves" $adminH @{ zoneId = $zoneId; pickerId = $pickerId; checkerId = $checkerId; items = $waveItems }).data.id
Write-Host "  波次ID: $waveId" -ForegroundColor Green

Write-Host "`n=== 完成拣货（全部无差异，实际=10）===" -ForegroundColor Yellow
$pickerH = @{ "X-User-Id" = $pickerId; "X-User-Role" = "picker" }
req POST "/api/picker/waves/$waveId/start-picking" $pickerH | Out-Null
$wave = (req GET "/api/waves/$waveId" $adminH).data
foreach ($item in $wave.items) {
    $scan = (req POST "/api/picker/waves/$waveId/scan-location" $pickerH @{ pickItemId = $item.pickItemId; scannedLocationCode = $item.locationCode }).data
    req POST "/api/picker/picking-records/$($scan.id)/submit-qty" $pickerH @{ actualQty = 10 } | Out-Null
}
$wave = (req POST "/api/picker/waves/$waveId/finish-picking" $pickerH).data
Write-Host "  拣货完成，状态: $($wave.status)" -ForegroundColor Green

Write-Host "`n=== 问题2：抽检流程不完整 验证 ===" -ForegroundColor Yellow
Write-Host "  连续3次 start-checking，验证随机性:"
$checkerH = @{ "X-User-Id" = $checkerId; "X-User-Role" = "checker" }
$sampleResults = @()
for ($i = 0; $i -lt 3; $i++) {
    $start = req POST "/api/checker/waves/$waveId/start-checking" $checkerH
    $sorted = ($start.sampledItemIds | Sort-Object) -join ','
    $sampleResults += $sorted
    Write-Host "    第$($i+1)次: 抽样$($start.sampleSize)个，IDs: $sorted"
}
$uniqueCount = ($sampleResults | Select-Object -Unique).Count
Write-Host "  3次抽样结果是否不同: $(if ($uniqueCount -gt 1) { '✅ 是（真正随机）' } else { '⚠️ 否（可能有问题）' })"
if ($uniqueCount -lt 2) { Write-Host "    ❌ 抽检随机性验证失败" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ 通过：抽检算法真正随机" -ForegroundColor Green

$checkStart = req POST "/api/checker/waves/$waveId/start-checking" $checkerH
$sampledIds = $checkStart.sampledItemIds
Write-Host "  抽检规模: $($checkStart.sampleSize) / $($checkStart.totalItems) (比例 $($checkStart.ratio))" -ForegroundColor Green

Write-Host "`n=== 问题3：复核记录可以重复提交 验证 ===" -ForegroundColor Yellow
Write-Host "  第一次提交复核记录（SKU数量=10无差异）"
$first = req POST "/api/checker/check-records" $checkerH @{ waveId = $waveId; pickItemId = $sampledIds[0]; checkedQty = 10; packingSuggestion = "标准包装" }
Write-Host "    状态: $($first.status)"
if (-not $first.ok) { Write-Host "    ❌ 失败: $($first.error)" -ForegroundColor Red; exit 1 }

Write-Host "`n  第二次提交（同一pickItemId重复提交）"
$second = req POST "/api/checker/check-records" $checkerH @{ waveId = $waveId; pickItemId = $sampledIds[0]; checkedQty = 10 }
Write-Host "    状态: $($second.status), 错误: $($second.error)"
if ($second.status -ne 409) { Write-Host "    ❌ 失败：重复提交应返回409" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ 通过：重复提交被正确拦截（409冲突）" -ForegroundColor Green

Write-Host "`n  额外验证：非抽检范围内的SKU不能提交复核"
$notSampled = $wave.items | Where-Object { $sampledIds -notcontains $_.pickItemId } | Select-Object -First 1
$r = req POST "/api/checker/check-records" $checkerH @{ waveId = $waveId; pickItemId = $notSampled.pickItemId; checkedQty = 10 }
Write-Host "    状态: $($r.status), 错误: $($r.error)"
if ($r.status -ne 400) { Write-Host "    ❌ 失败：非抽检SKU应返回400" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ 通过：非抽检范围SKU被正确拦截" -ForegroundColor Green

Write-Host "`n=== 问题4：无差异波次不能正常完结 验证 ===" -ForegroundColor Yellow
$waveBefore = (req GET "/api/waves/$waveId" $adminH).data
Write-Host "  提交全部复核前波次状态: $($waveBefore.status)"

Write-Host "  提交剩余 $($sampledIds.Count - 1) 条复核记录（全部无差异）..."
for ($i = 1; $i -lt $sampledIds.Count; $i++) {
    $pickItemId = $sampledIds[$i]
    req POST "/api/checker/check-records" $checkerH @{ waveId = $waveId; pickItemId = $pickItemId; checkedQty = 10; packingSuggestion = "标准包装" } | Out-Null
    Write-Host "    已提交 $($i+1)/$($sampledIds.Count)"
}

$waveAfter = (req GET "/api/waves/$waveId" $adminH).data
Write-Host "`n  全部复核提交后波次状态: $($waveAfter.status)"
if ($waveAfter.status -ne "可包装") {
    Write-Host "  ❌ 失败：无差异波次应自动流转到'可包装'，实际是 '$($waveAfter.status)'" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ 通过：无差异波次正确自动流转到可包装" -ForegroundColor Green

Write-Host "`n=== 完成包装确认和最终关闭 ===" -ForegroundColor Yellow
$checks = (req GET "/api/checker/check-records?waveId=$waveId" $adminH).data
foreach ($rec in $checks) {
    req POST "/api/checker/check-records/$($rec.id)/confirm-packing" $checkerH @{ packageNo = "PKG-$($rec.id.Substring(0,8))" } | Out-Null
}
Write-Host "  全部包装确认完成"

$finalWave = (req POST "/api/checker/waves/$waveId/final-confirm" $checkerH).data
Write-Host "  最终确认后状态: $($finalWave.status)"
if ($finalWave.status -ne "已关闭") { Write-Host "  ❌ 失败：波次未能关闭" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ 通过：波次正常完结关闭" -ForegroundColor Green

Write-Host "`n`n==================================================" -ForegroundColor Cyan
Write-Host "🎉 全部4个问题修复验证通过！" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "`n修复总结:" -ForegroundColor White
Write-Host "  ✅ 问题1: 鉴权增强 - 校验用户存在性+角色匹配+是否禁用" -ForegroundColor Green
Write-Host "  ✅ 问题2: 抽检真正随机 - Fisher-Yates 洗牌算法抽样" -ForegroundColor Green
Write-Host "  ✅ 问题3: 防重复复核 - waveId+pickItemId 唯一约束" -ForegroundColor Green
Write-Host "  ✅ 问题4: 无差异自动流转 - 待复核→可包装自动切换" -ForegroundColor Green
Write-Host "  ✅ 额外: 非抽检范围SKU禁止复核 + 首用户引导创建" -ForegroundColor Green
Write-Host ""
