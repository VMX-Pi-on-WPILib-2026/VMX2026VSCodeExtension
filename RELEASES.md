# Release format (vmx2026.json, schemaVersion 1 / 2)

Each component is a GitHub release in its own repository with a `vmx2026.json`
manifest and its ZIP(s). Do not use GitHub's generated source archives.
`tools/package_release.py` writes both.

The two manifests of a pair have the same `wpilibVersion` (the WPILib release, for
example `2026.2.2`). `version` is the component's Maven version and must match its
Maven repository exactly; use a version that cannot be confused with upstream
(`2026.2.2-vmx.1`). Never replace a published ZIP; publish a new version instead.

```json
{
  "schemaVersion": 1,
  "component": "gradlerio",
  "version": "2026.2.2-vmx.1",
  "wpilibVersion": "2026.2.2",
  "archive": "vmx2026-gradlerio-2026.2.2-vmx.1.zip",
  "sha256": "64-character SHA-256 of the ZIP",
  "mavenPath": "maven"
}
```

Schema 2 splits a large component: `additionalArchives` lists up to 15 more
`{ "archive", "sha256" }` parts, extracted into the same folder.

## GradleRIO (`VMX-Pi-on-WPILib-2026/GradleRIO`)

`maven/` holds the plugin and its marker:

```text
maven/edu/wpi/first/GradleRIO/<version>/GradleRIO-<version>.jar|.pom
maven/edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin/<version>/...
```

```bash
./gradlew publishToMavenLocal -PpublishVersion=<version> -Dmaven.repo.local=<dir>
python3 tools/package_release.py gradlerio --version <version> --wpilib-version <wpilib> --maven <dir> --output <out>
```

## VMX HAL (`VMX-Pi-on-WPILib-2026/allwpilib`, component `allwpilib`)

`maven/` holds `edu.wpi.first.hal:hal-cpp` and `hal-java` at `version`: the
`linuxarm64` binaries are the VMX-pi HAL, every other platform is the upstream HAL of
`wpilibVersion`. Projects use this repository only for group `edu.wpi.first.hal` at that
version; all other WPILib artifacts come from the official WPILib Maven.

```bash
python3 vmx/build_vmx_hal_maven.py --vmx-version <version> --output <dir>
python3 tools/package_release.py allwpilib --version <version> --wpilib-version <wpilib> --maven <dir> --output <out>
```

Studica's VMX HAL library (`libvmxpi_hal_cpp.so`, `VMXPi.h`) is never part of a release:
`libwpiHal.so` only references it and the robot provides it. The packaging tool refuses
archives that contain it.
