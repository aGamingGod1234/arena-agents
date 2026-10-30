param([ValidateSet('A','B')][string]$Worker='A',[switch]$SkipSurvey)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if([Environment]::MachineName -ne 'Desktop'){throw 'wrong host'}
$r="$env:USERPROFILE\arena-runner";$d="$r\d39-pearls4";$src="$d\src";$port=if($Worker-eq'A'){56000}else{56100}
$env:JAVA_HOME="$r\jdk25";$env:ARENA_HEADLESS_SERVER_TEMPLATE="$r\long-template";$env:SLOT_PORT_BASE="$port"
$env:OPENAI_API_KEY=$null;$env:ANTHROPIC_API_KEY=$null;$env:CODEX_HOME=$null;$env:CLAUDE_CONFIG_DIR=$null
$jar="$r\jars\d25-4682f12e.jar";$sha='af6f3f0958614ac6401709ba2e3f1fe62399f5c2'
if((&git -C $src rev-parse HEAD)-ne$sha){throw 'source mismatch'}
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
   if($os.FreePhysicalMemory/1MB-ge($os.TotalVisibleMemorySize/1MB*.1+3)-and$cpu.Maximum-lt80){
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
 if($Worker-eq'A'-and !$SkipSurvey){
  RunJob 'survey' @('evals/d39-pearls4/survey.mjs',"$d\checkpoints","$d\survey",$jar)
 }
 $seeds=if($Worker-eq'A'){@('123456789','987654321')}else{@('8675309','20261024')}
 foreach($seed in $seeds){
  $tag="d39-pearls4-$seed";$out="$r\sub\long\$tag-codex"
  if(Test-Path "$d\$tag.done"){continue}
  RunJob $tag @('scripts/quality/run-long.mjs','--provider','codex','--model','gpt-6.1-sol','--effort','low','--service-tier','default','--codex-observer-cap','yes','--budget-minutes','90','--max-total-cost-usd','1000','--ledger',"$out.ledger.json",'--port-base',"$port",'--jar',$jar,'--coordinator-root',$src,'--server-template',"$r\long-template",'--java',"$env:JAVA_HOME\bin\java.exe",'--checkpoint',"$d\checkpoints\9-nether-entry-$seed-v2.json",'--out',$out)
  Copy-Item "$d\$tag.done" "$out.done"
 }
 Status 'finished' ''
}catch{Status 'error' $_.Exception.Message;$_|Out-String|Set-Content "$d\worker-$Worker-error.log";exit 1}
