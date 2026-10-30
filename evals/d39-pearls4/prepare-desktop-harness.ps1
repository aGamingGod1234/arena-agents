$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'
if([Environment]::MachineName-ne'Desktop'){throw 'wrong host'}
$d="$env:USERPROFILE\arena-runner\d39-pearls4";$h="$d\harness2"
$me=Get-Process -Id $PID;$me.PriorityClass='BelowNormal';$me.ProcessorAffinity=[IntPtr]16383
try{
 if(Test-Path $h){throw 'Harness checkout already exists; inspect before reuse'}
 & git.exe clone --quiet --shared --no-checkout "$d\src" $h > "$d\harness-prepare.log" 2>&1
 if($LASTEXITCODE){throw 'Clone failed'}
 & git.exe -C $h fetch --quiet "$d\harness.bundle" HEAD >> "$d\harness-prepare.log" 2>&1
 if($LASTEXITCODE){throw 'Bundle fetch failed'}
 & git.exe -C $h checkout --quiet --detach FETCH_HEAD >> "$d\harness-prepare.log" 2>&1
 if($LASTEXITCODE){throw 'Checkout failed'}
 $head=(&git.exe -C $h rev-parse HEAD)
 if(!$head.StartsWith('d3dbc5c1')){throw 'Harness commit mismatch'}
 & npm.cmd ci --silent --prefix "$h\coordinator" >> "$d\harness-prepare.log" 2>&1
 if($LASTEXITCODE){throw 'Harness dependencies failed'}
 Push-Location $h
 try{& node.exe --test coordinator/test/headless-matrix.test.mjs > "$d\harness-gate.log" 2>&1;$gate=$LASTEXITCODE}finally{Pop-Location}
 if($gate){throw 'Harness gate failed'}
 [pscustomobject]@{head=$head;gate=$gate;at=(Get-Date -Format o);status='ready'}|ConvertTo-Json|Set-Content "$d\harness2-ready.json"
}catch{[pscustomobject]@{status='failed';reason=$_.Exception.Message;at=(Get-Date -Format o)}|ConvertTo-Json|Set-Content "$d\harness2-ready.json";exit 1}
