Set-StrictMode -Version Latest

# The Minecraft target (26.1, 26.2, 26.3) a script works with, as ./gradlew -Pmc=<target> does: empty is the default
# in gradle.properties, any other loads gradle/mc/<target>.properties over it. Use-ArenaMinecraftTarget sets it.
$script:ArenaMinecraftTarget = ''

function Read-ArenaPropertyFile([string] $Path, [string] $Name) {
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
	$found = @(
		Get-Content -LiteralPath $Path |
			Where-Object { $_ -match "^$([regex]::Escape($Name))=(.+)$" } |
			ForEach-Object { $Matches[1].Trim() }
	)
	if ($found.Count -eq 0) { return $null }
	if ($found.Count -ne 1 -or $found[0] -notmatch '^[0-9A-Za-z][0-9A-Za-z._+<>= -]*$') {
		throw "$Path must contain one valid $Name value"
	}
	return $found[0]
}

function Get-ArenaGradleProperty([string] $ProjectRoot, [string] $Name) {
	$propertiesPath = Join-Path $ProjectRoot 'gradle.properties'
	if (-not (Test-Path -LiteralPath $propertiesPath -PathType Leaf)) { return $null }
	if (-not [string]::IsNullOrEmpty($script:ArenaMinecraftTarget)) {
		$targetValue = Read-ArenaPropertyFile (Join-Path $ProjectRoot "gradle\mc\$($script:ArenaMinecraftTarget).properties") $Name
		if ($null -ne $targetValue) { return $targetValue }
	}
	$value = Read-ArenaPropertyFile $propertiesPath $Name
	if ($null -eq $value) { throw "gradle.properties must contain one valid $Name value: $propertiesPath" }
	return $value
}

function Use-ArenaMinecraftTarget([string] $ProjectRoot, [string] $Target) {
	$script:ArenaMinecraftTarget = ''
	$default = Get-ArenaGradleProperty $ProjectRoot 'mc_compat'
	if ([string]::IsNullOrWhiteSpace($Target) -or $Target -eq $default) { return $default }
	if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "gradle\mc\$Target.properties") -PathType Leaf)) {
		throw "Unknown Minecraft target $Target (no gradle\mc\$Target.properties); the default is $default"
	}
	$script:ArenaMinecraftTarget = $Target
	return $Target
}

# Arguments that select the current target for a Gradle call (none for the default).
function Get-ArenaGradleTargetArguments {
	if ([string]::IsNullOrEmpty($script:ArenaMinecraftTarget)) { return @() }
	return @("-Pmc=$($script:ArenaMinecraftTarget)")
}

function Get-ArenaModVersion([string] $ProjectRoot) {
	$version = Get-ArenaGradleProperty $ProjectRoot 'mod_version'
	# A non-default target says so in its JAR version, as build.gradle names it (arena-agents-0.2.0+mc26.2.jar).
	if ($null -ne $version -and -not [string]::IsNullOrEmpty($script:ArenaMinecraftTarget)) { return "$version+mc$($script:ArenaMinecraftTarget)" }
	return $version
}

function Resolve-ArenaModJar([string] $ProjectRoot) {
	$version = Get-ArenaModVersion $ProjectRoot
	$libraryDirectory = Join-Path $ProjectRoot 'build\libs'
	if ($null -ne $version) {
		return Join-Path $libraryDirectory "arena-agents-$version.jar"
	}
	$candidates = @(Get-ChildItem -LiteralPath $libraryDirectory -Filter 'arena-agents-*.jar' -File -ErrorAction SilentlyContinue)
	if ($candidates.Count -ne 1) {
		throw "Could not resolve exactly one Arena Agents JAR under $libraryDirectory"
	}
	return $candidates[0].FullName
}

function Resolve-ArenaCarpetJar([string] $ProjectRoot) {
	$version = Get-ArenaGradleProperty $ProjectRoot 'carpet_version'
	$libraryDirectory = Join-Path $ProjectRoot 'libs'
	if ($null -ne $version) {
		return Join-Path $libraryDirectory "fabric-carpet-$version.jar"
	}
	$candidates = @(Get-ChildItem -LiteralPath $libraryDirectory -Filter 'fabric-carpet-*.jar' -File -ErrorAction SilentlyContinue)
	if ($candidates.Count -ne 1) {
		throw "Could not resolve exactly one Fabric Carpet JAR under $libraryDirectory"
	}
	return $candidates[0].FullName
}
