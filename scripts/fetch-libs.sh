#!/usr/bin/env bash
# Download the third-party mod JARs the build expects in libs/ and verify them against libs/checksums.sha256.
# They are not committed because they belong to their upstream projects; see libs/README.md for provenance.
set -euo pipefail
cd "$(dirname "$0")/../libs"
fetch() {
	[[ -f "$1" ]] || curl -fsSL --retry 3 -o "$1" "$2"
}
fetch 'fabric-carpet-26.3+v260915.jar' 'https://github.com/gnembon/fabric-carpet/releases/download/v26.3/fabric-carpet-26.3%2Bv260915.jar'
fetch 'voicechat-fabric-2.6.27+26.3.jar' 'https://cdn.modrinth.com/data/9eGKb6K1/versions/x9jLR94Q/voicechat-fabric-2.6.27%2B26.3.jar'
sha256sum -c checksums.sha256
