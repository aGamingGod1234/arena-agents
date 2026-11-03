Set-StrictMode -Version Latest

function Assert-ArenaRuntimeTarget([string[]] $Directories, [System.Collections.IDictionary] $Expected) {
    foreach ($directory in $Directories) {
        $marker = Join-Path $directory '.arena-runtime-target.json'
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            $installed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
            foreach ($key in $Expected.Keys) {
                $property = $installed.PSObject.Properties[$key]
                if ($null -eq $property -or [string]$property.Value -cne [string]$Expected[$key]) {
                    throw "Runtime target mismatch ($key) at $directory. Preserve this runtime and its worlds; use a separate project/profile location for the selected versions."
                }
            }
        } elseif ((Test-Path -LiteralPath $directory) -and
            @(Get-ChildItem -LiteralPath $directory -Force).Count -gt 0) {
            # Never guess the version of a legacy launcher, mod set, or world.
            throw "Runtime target is unknown at $directory (missing $marker). Preserve this runtime and its worlds; use an empty project/profile location for preparation."
        }
    }
}

function Initialize-ArenaRuntimeTarget([string[]] $Directories, [System.Collections.IDictionary] $Expected) {
    # Validate every shared profile before writing even the first marker.
    Assert-ArenaRuntimeTarget $Directories $Expected
    foreach ($directory in $Directories) {
        $marker = Join-Path $directory '.arena-runtime-target.json'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
            [IO.File]::WriteAllText($marker, ($Expected | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        }
    }
}
