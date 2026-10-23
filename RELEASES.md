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

## GradleRIO (`VMXONWPI/GradleRIO`)

`maven/` holds the plugin and its marker:

```text
maven/edu/wpi/first/GradleRIO/<version>/GradleRIO-<version>.jar|.pom
maven/edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin/<version>/...
```

```bash
./gradlew publishToMavenLocal -PpublishVersion=<version> -Dmaven.repo.local=<dir>
python3 tools/package_release.py gradlerio --version <version> --wpilib-version <wpilib> --maven <dir> --output <out>
```

## VMX HAL (`VMXONWPI/allwpilib`, component `allwpilib`)

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

## Studica robot libraries (extension 2.0.4 and later)

An allwpilib manifest may declare `"robotLibraries": true`. That release also
contains `edu.wpi.first.wpilibc:wpilibc-cpp` (headers, sources and linuxarm64
release/debug shared/static libraries) and `edu.wpi.first.wpilibj:wpilibj-java`
(JAR, sources and Javadoc) at the same `version`. Package with
`--with-robot-libraries`. The extension verifies required artifacts and selects
these versions only for the VMX target. Switching to RoboRIO uses upstream
wpilibc/wpilibj. HAL selection retains the existing multi-platform behavior.
Older HAL-only manifests are still accepted.

2026.2.2-vmx.6 includes the original Studica 1.1.8 public C++/Java APIs and matching
SerialPort DTR JNI. The custom C++ libraries target linuxarm64 only; desktop
C++ simulation using Studica classes requires a separate platform build.
Java serial/DTR hardware APIs require the matching VMX robot-side JNI and
physical device. These additions have host and link checks but no robot hardware
validation. The proprietary Studica VMX SDK is still provided by the robot image.


## HALSIM loader compatibility

The 2026.2.2-vmx.6 linuxarm64 HAL exports the HALSIM APIs referenced by wpilibc, avoiding loader errors such as `undefined symbol: HALSIM_CancelRoboRioVInCurrentCallback`. Install VMX2026 extension 2.0.5, run `Update VMX2026 Version`, and redeploy to pick up the fixed runtime.


The 2026.2.2-vmx.6 HAL also fixes a dangling temporary string in the `HAL_HandleEnum` lookup that aborted during HAL initialization.


The 2026.2.2-vmx.6 HAL fixes right-buddy address calculation in the logging memory pool.
