Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load the real gate without launching a server or changing machine configuration.
$source = Join-Path $PSScriptRoot 'run-headless-provider-matrix.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Headless wrapper has PowerShell parse errors' }
$definition = $ast.Find({ param($node)
	$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CoordinatorReady'
}, $true)
Invoke-Expression $definition.Extent.Text

$audit = Join-Path ([IO.Path]::GetTempPath()) ("readiness-{0}.jsonl" -f [Guid]::NewGuid())
$scenario = [pscustomobject] @{ provider = 'codex'; model = 'fixture'; reasoningEffort = 'low'; serviceTier = 'priority' }
$model = @{ provider = 'codex'; model = 'fixture'; id = 'fixture'; reasoningEfforts = @('low'); serviceTiers = @('priority') }
$catalog = @{ direction = 'coordinator_to_server'; envelope = @{ type = 'catalog_snapshot'; payload = @{ models = @($model) } } }
$status = @{ direction = 'coordinator_to_server'; envelope = @{ type = 'coordinator_status'; payload = @{ components = @(@{ component = 'provider:codex'; state = 'ready' }) } } }
function Assert-Ready($Rows, [bool] $Expected, [string] $Label) {
	$lines = @($Rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 12 -Compress })
	[IO.File]::WriteAllLines($audit, [string[]] $lines)
	if ((Test-CoordinatorReady $audit $scenario) -ne $Expected) { throw "Readiness failed: $Label" }
}
try {
	Assert-Ready @($catalog, $status) $true 'healthy bridge without hello_ack'
	Assert-Ready @($catalog) $true 'matching authenticated catalog without hello_ack'
	Assert-Ready @($status) $false 'provider status still needs a catalog'
	$wrongDirection = @{ direction = 'server_to_coordinator'; envelope = $catalog.envelope }
	Assert-Ready @($wrongDirection, $status) $false 'inbound catalog cannot prove coordinator readiness'
	$model.model = 'other'
	Assert-Ready @($catalog) $false 'unmatched profile without settled provider'
	Assert-Ready @($catalog, $status) $true 'settled provider can report an unsupported profile'
	$model.provider = 'claude'
	Assert-Ready @($catalog, $status) $false 'unrelated provider catalog'
	$model.provider = 'codex'
	$model.model = 'fixture'
	$hello = @{ direction = 'server_to_coordinator'; envelope = @{ type = 'hello_ack'; payload = @{ authenticated = $true } } }
	Assert-Ready @($hello, $catalog) $true 'original handshake path'
	[Console]::Out.WriteLine('Coordinator readiness checks passed')
} finally {
	Remove-Item -LiteralPath $audit -Force -ErrorAction SilentlyContinue
}
