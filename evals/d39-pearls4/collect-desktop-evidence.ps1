$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if([Environment]::MachineName-ne'Desktop'){throw 'wrong host'}
$me=Get-Process -Id $PID;$me.PriorityClass='BelowNormal';$me.ProcessorAffinity=[IntPtr]16383
$r="$env:USERPROFILE\arena-runner";$d="$r\d39-pearls4";$out="$d\evidence-final"
foreach($root in @('src','harness2')){
 if(Test-Path "$d\$root\runtime\headless-runs"){
  & node.exe "$d\export-evidence.mjs" "$d\$root" "$out\candidate-all" --all-runs
  if($LASTEXITCODE){throw 'candidate export failed'}
 }
}
foreach($build in @('4682f12e','9203dd1e')){
 if(Test-Path "$r\aa-run-$build"){
  & node.exe "$d\export-evidence.mjs" "$r\aa-run-$build" "$out\queue-$build-all" --all-runs
  if($LASTEXITCODE){throw 'queue export failed'}
 }
}
foreach($arm in @('base','candidate')){
 Get-ChildItem "$d\physical\$arm" -Directory -ErrorAction SilentlyContinue|ForEach-Object{
  $to="$out\physical\$arm\$($_.Name)";New-Item -ItemType Directory -Force $to|Out-Null
  foreach($name in @('result.json','actions.jsonl')){if(Test-Path "$($_.FullName)\$name"){Copy-Item "$($_.FullName)\$name" "$to\$name"}}
 }
}
foreach($f in @('launches.jsonl','physical-boundary.jsonl','physical-controller.sha256')){if(Test-Path "$d\$f"){Copy-Item "$d\$f" "$out\$f"}}
$summaryDir="$out\summaries";New-Item -ItemType Directory -Force $summaryDir|Out-Null
foreach($pattern in @('d39-pearls4-*-codex','d39-nether-entry-*-codex')){
 Get-ChildItem "$r\sub\long\$pattern" -Directory -ErrorAction SilentlyContinue|ForEach-Object{
  $tag=$_.Name;$p="$($_.FullName)\long-run.json"
  if(Test-Path $p){
   try{
    $long=Get-Content $p -TotalCount 20000|Out-String|ConvertFrom-Json -ErrorAction Stop
    $selected=$long|Select-Object schemaVersion,runId,seed,windowMs,profile,build,termination,ending,measurementStatus,observerErrors,diagnostics,stopRequest,failure,capturedAt
    $selected|Add-Member -NotePropertyName run -NotePropertyValue (Split-Path $long.artifacts -Leaf)
    $selected|ConvertTo-Json -Depth 12|Set-Content "$summaryDir\$($_.Name).json"
   }catch{
    [pscustomobject]@{tag=$tag;status='unreadable summary';at=(Get-Date -Format o)}|ConvertTo-Json -Compress|Add-Content "$out\summary-errors.jsonl"
   }
  }
 }
}
# Interrupted games may never write a final summary; retain only their public run binding.
$bindings=@();Get-ChildItem "$d\d39-pearls4-*.log" -File -ErrorAction SilentlyContinue|Where-Object{$_.Name-notlike'*.stderr.log'}|ForEach-Object{
 $tag=$_.BaseName
 Select-String -Path $_.FullName -Pattern 'Watching.*q-'|ForEach-Object{
  if($_.Line-match'(q-[a-zA-Z0-9-]+)'){$bindings+=@{tag=$tag;run=$Matches[1]}}
 }
}
ConvertTo-Json -InputObject $bindings -Depth 3|Set-Content "$out\game-bindings.json"
Get-ChildItem "$d\d39-pearls4-*.done" -ErrorAction SilentlyContinue|ForEach-Object{Copy-Item $_.FullName "$out\$($_.Name)"}
$receipts="$out\launch-receipts";New-Item -ItemType Directory -Force $receipts|Out-Null
foreach($pattern in @('physical-*.done','worker-*-status.json','harness2-ready.json')){Get-ChildItem "$d\$pattern" -File -ErrorAction SilentlyContinue|ForEach-Object{Copy-Item $_.FullName "$receipts\$($_.Name)"}}
& tar.exe -czf "$d\evidence-final.tar.gz" -C $out .
if($LASTEXITCODE){throw 'pack failed'}
[pscustomobject]@{archiveBytes=(Get-Item "$d\evidence-final.tar.gz").Length}|ConvertTo-Json
