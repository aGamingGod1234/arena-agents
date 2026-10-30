# Run from a detached worker (e.g. Win32_Process.Create) so this survives an SSH disconnect.
param(
 [Parameter(Mandatory)][string]$Root,
 [Parameter(Mandatory)][string]$Jar,
 [Parameter(Mandatory)][string]$Out,
 [int]$PortBase=34000,
 [int]$Repeats=3,
 [int]$RunSeconds=240,
 [string]$Variants='gap0,gap5',
 [switch]$Shelter,
 [ValidateSet('none','bow','snowball')][string]$Ranged='none',
 [switch]$NoRoof,
 [long]$CpuMask=1,
 [ValidateSet('north','south','east','west')][string]$Opening='east',
 [string]$RunnerRoot=(Join-Path $env:USERPROFILE 'arena-runner')
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($PortBase -lt 34000 -or $PortBase+2 -gt 34900){throw 'Probe ports must stay in 34000-34900'}
if(Test-Path $Out){throw 'Use a fresh probe output directory'}
if(-not (Test-Path "$RunnerRoot\jdk25\bin\java.exe")){throw 'Desktop runner JDK missing'}
if(-not (Test-Path $Jar)){throw 'Probe jar missing'}
$os=Get-CimInstance Win32_OperatingSystem;$free=$os.FreePhysicalMemory/1MB;$required=$os.TotalVisibleMemorySize/1MB*0.1+3
if($free -lt $required){"not started: $free GB free < $required GB (3 GB job plus 10% reserve)";exit 2}
foreach($port in $PortBase,($PortBase+1),($PortBase+2)){
 if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw "Port $port already used"}
}
$cpu=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
if($cpu -gt 60){"not started: CPU $cpu percent leaves insufficient headroom";exit 2}
$p=Get-Process -Id $PID;$p.PriorityClass='BelowNormal'
$p.ProcessorAffinity=[IntPtr]$CpuMask
$env:JAVA_TOOL_OPTIONS='-XX:ActiveProcessorCount=1'
$env:JAVA_HOME="$RunnerRoot\jdk25";$env:ARENA_HEADLESS_SERVER_TEMPLATE="$RunnerRoot\server-template"
$env:ARENA_JAR=$Jar;$env:SLOT_PORT_BASE="$PortBase";$env:REPEATS="$Repeats";$env:RUN_S="$RunSeconds"
$env:RANGED=$Ranged;$env:ROOF=if($NoRoof){'0'}else{'1'}
$env:VARIANTS=$Variants;$env:START_MODE='deck';$env:SHELTER=if($Shelter){'1'}else{'0'};$env:OPENING=$Opening
Set-Location $Root
& cmd.exe /d /c "node scripts/quality/test-blaze-spawner-live.mjs `"$Out`" > `"$Out.log`" 2>&1"
$code=$LASTEXITCODE
"exit=$code $(Get-Date -Format o)" | Set-Content "$Out.done"
exit $code
