param([ValidateSet('L')][string]$Worker='L',[string[]]$Seeds=@('20261024'),[switch]$SkipSetup)
$Seeds=@($Seeds|ForEach-Object{$_ -split ','})
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if([Environment]::MachineName -ne 'Desktop'){throw 'wrong host'}
$r="$env:USERPROFILE\arena-runner";$d="$r\d39-pearls4";$src="$d\src";$port=57100
$env:JAVA_HOME="$r\jdk25";$env:ARENA_HEADLESS_SERVER_TEMPLATE="$r\long-template";$env:SLOT_PORT_BASE="$port"
$env:OPENAI_API_KEY=$null;$env:ANTHROPIC_API_KEY=$null;$env:CODEX_HOME=$null;$env:CLAUDE_CONFIG_DIR=$null
$jar="$r\jars\d25-4682f12e.jar";$sha='af6f3f0958614ac6401709ba2e3f1fe62399f5c2'
if((&git -C $src rev-parse HEAD)-ne$sha){throw 'source mismatch'}
$env:REPLAY_JAVA_OPTS='-XX:ActiveProcessorCount=4'
$base="$d\base"
$me=Get-Process -Id $PID;$me.PriorityClass='BelowNormal';$me.ProcessorAffinity=[IntPtr]16383
function Status($state,$job){[pscustomobject]@{host=[Environment]::MachineName;pid=$PID;worker=$Worker;state=$state;job=$job;at=(Get-Date -Format o)}|ConvertTo-Json|Set-Content "$d\worker-$Worker-status.json"}
function RunJob($name,$arguments){
 Status 'waiting_for_capacity' $name
 $mutex=New-Object Threading.Mutex($false,'Local\AA-d39-pearls4-admission')
 $lock=$null
 while($null-eq$lock){
  try{$acquired=$mutex.WaitOne(30000)}catch [System.Threading.AbandonedMutexException]{$acquired=$true}
  if(!$acquired){continue}
  try{
   $os=Get-CimInstance Win32_OperatingSystem
   $java=@(Get-CimInstance Win32_Process -Filter "Name='java.exe'"|Where-Object {$_.CommandLine -match 'arena-runner|fabric-server-launch'})
   $cpu=(Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 3 -MaxSamples 4).CounterSamples.CookedValue|Measure-Object -Maximum
   if($os.FreePhysicalMemory/1MB-ge($os.TotalVisibleMemorySize/1MB*.1+3)-and$cpu.Maximum-lt$(if($Worker-eq'L'){70}else{80})){
    New-Item -ItemType Directory -Force "$r\locks"|Out-Null
    for($i=0;$i-lt4;$i++){
     try{$lock=[IO.File]::Open("$r\locks\live-$i.lock",[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);break}catch [IO.IOException]{}
    }
   }
  }finally{$mutex.ReleaseMutex()}
  if($null-eq$lock){Start-Sleep 20}
 }
 try{
  foreach($p in @($port,($port+1),($port+2))){$probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$p);try{$probe.Start()}finally{$probe.Stop()}}
  Status 'running' $name
  $quoted=$arguments|ForEach-Object{'"'+$_.Replace('"','\"')+'"'}
  $p=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $quoted -WorkingDirectory $src -PassThru -WindowStyle Hidden -RedirectStandardOutput "$d\$name.log" -RedirectStandardError "$d\$name.stderr.log"
  $p.PriorityClass='BelowNormal';$p.ProcessorAffinity=[IntPtr]16383
  $p.Id|Set-Content "$d\$name.pid"
  $identity=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
  [pscustomobject]@{job=$name;pid=$p.Id;source=$src;commit=$sha;jarSha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLower();commandLine=$identity.CommandLine;at=(Get-Date -Format o)}|ConvertTo-Json -Compress|Add-Content "$d\launches.jsonl"
  $held=$p.Handle;$p.WaitForExit();$exit=$p.ExitCode
  [pscustomobject]@{job=$name;exit=$exit;at=(Get-Date -Format o)}|ConvertTo-Json|Set-Content "$d\$name.done"
 }finally{if($null-ne$lock){$lock.Dispose()};$mutex.Dispose()}
}
try{
 $candidate=$src
 if(!$SkipSetup){
 Copy-Item "$candidate\scripts\quality\test-gold-route-live.mjs" "$base\scripts\quality\test-gold-route-live.mjs"
 RunJob 'survey-v2' @('evals/d39-pearls4/survey.mjs',"$d\checkpoints","$d\survey-v2",$jar)
 RunJob 'calibration4' @('scripts/quality/test-gold-route-live.mjs',"$d\checkpoints\9-nether-entry-123456789-v2.json","$d\calibration4",$jar,'90','1')
 $cal=Get-Content "$d\calibration4\result.json" -TotalCount 20000|Out-String|ConvertFrom-Json
 if($cal.error){throw "calibration failed: $($cal.error)"}
 $dx=$cal.start.x-$cal.endPosition.x;$dz=$cal.start.z-$cal.endPosition.z
 if($cal.oresSeen-eq0-and[math]::Sqrt($dx*$dx+$dz*$dz)-le8){throw 'calibration did not escape shelter'}
 (Get-FileHash "$candidate\scripts\quality\test-gold-route-live.mjs" -Algorithm SHA256).Hash.ToLower()|Set-Content "$d\physical-controller.sha256"
 }else{
  $expected=(Get-Content "$d\physical-controller.sha256" -TotalCount 1).Trim()
  foreach($root in @($candidate,$base)){if((Get-FileHash "$root\scripts\quality\test-gold-route-live.mjs" -Algorithm SHA256).Hash.ToLower()-ne$expected){throw 'frozen controller mismatch'}}
 }
 $jobs=@(
  @{seed='987654321';repeat=2;arm='base'},
  @{seed='987654321';repeat=3;arm='base'},
  @{seed='987654321';repeat=3;arm='candidate'},
  @{seed='20261024';repeat=3;arm='base'},
  @{seed='20261024';repeat=3;arm='candidate'}
 )
 $ordinal=0
 foreach($job in $jobs){
  $seed=$job.seed;$repeat=$job.repeat;$arm=$job.arm
  $port=57100+$ordinal*10;$ordinal++;$env:SLOT_PORT_BASE="$port"
  $src=if($arm-eq'base'){$base}else{$candidate};$sha=(&git -C $src rev-parse HEAD)
  $out="$d\physical\$arm\$seed-r$repeat-retry2";New-Item -ItemType Directory -Force (Split-Path $out)|Out-Null
  $name="physical-$arm-$seed-r$repeat-retry2"
  RunJob $name @('scripts/quality/test-gold-route-live.mjs',"$d\checkpoints\9-nether-entry-$seed-v2.json",$out,$jar,'600',"$repeat")
  $receipt=Get-Content "$d\$name.done" -TotalCount 30|Out-String|ConvertFrom-Json
  if($receipt.exit-ne0){throw "Physical child failed: $name; preserve the failed output"}
 }
 Status 'finished' ''
}catch{Status 'error' $_.Exception.Message;$_|Out-String|Set-Content "$d\worker-$Worker-error.log";exit 1}
