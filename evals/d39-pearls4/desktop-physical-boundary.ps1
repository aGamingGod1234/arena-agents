$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if([Environment]::MachineName-ne'Desktop'){throw 'wrong host'}
$d="$env:USERPROFILE\arena-runner\d39-pearls4";$deadline=[DateTime]::UtcNow.AddHours(2)
$me=Get-Process -Id $PID;$me.PriorityClass='BelowNormal'
while([DateTime]::UtcNow-lt$deadline){
 if(Test-Path "$d\physical-candidate-123456789-r3.done"){
  $s=Get-Content "$d\worker-C-status.json" -TotalCount 30|Out-String|ConvertFrom-Json
  if($s.pid-eq42536-and$s.state-eq'waiting_for_capacity'-and$s.job-eq'physical-base-8675309-r1'){
   $p=Get-CimInstance Win32_Process -Filter "ProcessId=42536"
   if(!$p-or!$p.CommandLine.Contains("$d\physical-worker-v2.ps1")){throw 'parent identity changed'}
   $children=@(Get-CimInstance Win32_Process|Where-Object{$_.ParentProcessId-eq42536-and$_.Name-eq'node.exe'})
   if($children.Count){throw 'a scored child is active; preserve it'}
   Stop-Process -Id 42536
   foreach($worker in @('C','D')){
    $seedArg=if($worker-eq'C'){'8675309'}else{'987654321,20261024'}
    $cmd="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$d\physical-split.ps1`" -Worker $worker -Seeds $seedArg -SkipSetup"
    $si=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$d;ProcessStartupInformation=$si}
    if($r.ReturnValue-ne0){throw 'split worker start failed'}
    [pscustomobject]@{worker=$worker;pid=$r.ProcessId;seeds=$seedArg;at=(Get-Date -Format o)}|ConvertTo-Json -Compress|Add-Content "$d\physical-boundary.jsonl"
   }
   exit 0
  }
  if($s.state-eq'running'-and$s.job-eq'physical-base-8675309-r1'){throw 'safe boundary missed; existing worker remains active'}
 }
 Start-Sleep 1
}
throw 'boundary deadline expired; existing worker remains active'
