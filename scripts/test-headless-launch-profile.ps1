Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'run-headless-provider-matrix.ps1'
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Wrapper parse failed'}
$definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-ScenarioConfig'},$true)
Invoke-Expression $definition.Extent.Text
$root=Join-Path ([IO.Path]::GetTempPath()) ('headless-launch-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root|Out-Null
try {
 $input=Join-Path $root 'source.json';$output=Join-Path $root 'result.json'
 @{bridge=@{host='old';port=1};codex=@{launchProfile=@{model='gpt-6-luna';reasoningEffort='xhigh';serviceTier='fast'}}}|ConvertTo-Json -Depth 8|Set-Content $input
 $scenario=[pscustomobject]@{provider='codex';model='gpt-6.1-sol';reasoningEffort='low';serviceTier='priority'}
 New-ScenarioConfig $input $output 28900 $root $scenario
 $config=Get-Content $output -Raw|ConvertFrom-Json
 foreach($key in @('model','reasoningEffort','serviceTier')){if($config.codex.launchProfile.$key -ne $scenario.$key){throw "Wrong launch profile $key"}}
 if($config.codex.launchProfile.cwd -ne $root -or $config.bridge.port -ne 28900){throw 'Workspace/port changed'}
 [Console]::Out.WriteLine('Headless exact launch-profile checks passed')
} finally {Remove-Item $root -Recurse -Force}
