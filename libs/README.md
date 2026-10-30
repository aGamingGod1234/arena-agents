# Local dependency provenance

The two JARs below are not committed to this repository because they belong to their upstream projects. Run `scripts/fetch-libs.sh` (Git Bash on Windows) to download both and check them against `checksums.sha256` before building.

`fabric-carpet-26.3+v260915.jar` comes from the upstream Fabric Carpet `v26.3` GitHub release:

https://github.com/gnembon/fabric-carpet/releases/download/v26.3/fabric-carpet-26.3%2Bv260915.jar

GitHub published the asset with SHA-256 digest `7c40b93e807ed914064176898037117097446c6cc76e6a80a856c8bf7f7659f9`. The tracked file matches that digest.

`voicechat-fabric-2.6.27+26.3.jar` comes from the Modrinth Simple Voice Chat release for Minecraft 26.3 / SVC 2.6.27 (version id `x9jLR94Q`):

https://cdn.modrinth.com/data/9eGKb6K1/versions/x9jLR94Q/voicechat-fabric-2.6.27%2B26.3.jar

The tracked file SHA-256 digest is `9e1c93144a3f7498e546102f6786aea6e4992866c4c5d21bd2e0edb702399153`. The voice add-on already depends on the same Modrinth version as `maven.modrinth:9eGKb6K1:x9jLR94Q`. `checksums.sha256` is the build-enforced record for every tracked local JAR.

Verify both files from PowerShell at the repository root:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\libs\fabric-carpet-26.3+v260915.jar
Get-FileHash -Algorithm SHA256 -LiteralPath .\libs\voicechat-fabric-2.6.27+26.3.jar
.\gradlew.bat verifyLocalDependencies
```

When updating Carpet or Simple Voice Chat, download an exact tagged release asset from the upstream project. Review its published digest, replace the JAR, and update `checksums.sha256` in the same change.
