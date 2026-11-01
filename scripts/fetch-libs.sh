#!/usr/bin/env bash
# Download the third-party mod JARs the build expects in libs/ and verify them against their checksum file.
# They are not committed because they belong to their upstream projects; see libs/README.md for provenance.
#
#   scripts/fetch-libs.sh          the default Minecraft target (gradle.properties)
#   scripts/fetch-libs.sh 26.2     a 26.x target from gradle/mc/<target>.properties (same as ./gradlew -Pmc=26.2)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-}"
properties="$root/gradle.properties"
if [[ -n "$target" ]]; then
	properties="$root/gradle/mc/$target.properties"
	[[ -f "$properties" ]] || { echo "Unknown Minecraft target $target (no gradle/mc/$target.properties)" >&2; exit 1; }
fi
# A target file overrides gradle.properties key by key.
value() {
	local found
	found="$(grep -E "^$1=" "$properties" | tail -1 | cut -d= -f2- || true)"
	[[ -n "$found" ]] || found="$(grep -E "^$1=" "$root/gradle.properties" | tail -1 | cut -d= -f2-)"
	printf '%s' "$found"
}
carpet="fabric-carpet-$(value carpet_version).jar"
voicechat="voicechat-fabric-$(value voicechat_version).jar"
voicechat_url="https://cdn.modrinth.com/data/9eGKb6K1/versions/$(value voicechat_modrinth_version)/voicechat-fabric-$(value voicechat_version | sed 's/+/%2B/g').jar"
checksums="$(value libs_checksums)"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
cd "$root/libs"
fetch() {
	[[ -f "$1" ]] && return 0
	# Download beside the final name and keep it only once it matches, so an interrupted download never lingers.
	curl -fsSL --proto '=https' --retry 3 -o "$1.part" "$2"
	local expected
	expected="$(awk -v name="$1" '$2 == name || $2 == "*" name { print $1 }' "$checksums")"
	if [[ "$(sha256 "$1.part" | cut -c1-64)" != "$expected" ]]; then
		rm -f "$1.part"
		echo "Checksum mismatch for $1 from $2" >&2
		exit 1
	fi
	mv "$1.part" "$1"
}
fetch "$carpet" "$(value carpet_url)"
fetch "$voicechat" "$voicechat_url"
sha256 -c "$checksums"
