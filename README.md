# VMX-Pi WPILib 2026 (VS Code extension)

For WPILib 2026 robot projects (C++ and Java), this extension installs the prebuilt
**VMX-pi HAL and GradleRIO releases from GitHub** and switches a project between the
RoboRIO and VMX-pi deploy targets. Nobody has to clone or build WPILib.

How it works: the VMX GradleRIO fork adds a `VmxPi` deploy target, and the VMX HAL
release replaces the WPILib HAL for `linuxarm64` with the VMX-pi HAL (every other
platform keeps the upstream HAL). See `VMX.md` in
[VMXONWPI/GradleRIO](https://github.com/VMXONWPI/GradleRIO)
and `vmx/README.md` in [VMXONWPI/allwpilib](https://github.com/VMXONWPI/allwpilib).

## Commands

From the VMX icon in the editor title bar, or the `VMX2026` command palette category.

| Command | Behavior |
|---|---|
| `Change the deploy target to VMX-Pi (from RoboRIO)` | Connects the installed release and switches the project to `VmxPi` / `linuxarm64`. |
| `Change the deploy target to RoboRIO (from VMX-Pi)` | Switches back. The release stays connected (its HAL repository also serves the roboRIO). |
| `Update VMX2026 Version` | Finds the newest compatible release pair, downloads and verifies it, and pins it in the project. |
| `Save VMX2026 Offline` | Installs the toolchain, resolves every dependency, builds online and then with `--offline --rerun-tasks`; only if all succeed, later wrapper builds run offline. |

## Getting started

1. Create a WPILib 2026 project (Groovy `build.gradle`) with the WPILib extension.
2. Run `Change the deploy target to VMX-Pi (from RoboRIO)`. The first time it downloads
   the release pair (a JDK and Internet access are needed).
3. Prepare the robot once (see `VMX.md`): 64-bit Ubuntu 24.04/26.04, Studica's
   `vmxpi-hal` package and Robot Manager `.deb` (creates `/home/lvuser` as a real directory),
   and for Java `openjdk-17-jre-headless`.
4. Optional: `Save VMX2026 Offline` while online.
5. Build and deploy as usual (`./gradlew build`, `./gradlew deploy`, or the WPILib
   extension's commands). The VMX login defaults to `ubuntu` / `password`.

Switching the target does not change robot code. Motor outputs on the VMX are only
enabled while the Driver Station is attached and enabled (VMX IO watchdog).

## Releases and project files

The default repositories are `VMXONWPI/GradleRIO` and
`VMXONWPI/allwpilib` (settings `vmx2026.gradleRIORepository`,
`vmx2026.allwpilibRepository`; `vmx2026.includePrereleases` defaults to `true`). The
extension looks at the 30 newest releases of each and picks a pair whose
`vmx2026.json` manifests have the same `wpilibVersion`; the format is in
[RELEASES.md](RELEASES.md). ZIPs are verified with SHA-256 and installed under
`~/wpilib/2026/VMX2026/releases/`. A failed download or check leaves the project
unchanged. Switching targets reuses the installed pair and needs no GitHub access.

In the project, `settings.gradle` gets a managed block for the GradleRIO plugin
repository, and `build.gradle` gets the pinned GradleRIO version, the target change and
one line at the end:

```groovy
apply from: new File(System.getProperty('user.home'), 'wpilib/2026/VMX2026/vmx2026.gradle')
```

That shared script selects the installed VMX HAL (`wpi.versions.vmxHalVersion` and its
repository) from per-project state kept in `~/wpilib/2026/VMX2026/projects/`, outside
the project, together with a one-time backup of the original `build.gradle` and
`settings.gradle`.

The target change renames: `RoboRIO` ↔ `VmxPi`, `FRCNativeArtifact` ↔
`WPILibNativeArtifact`, `FRCJavaArtifact` ↔ `WPILibJavaArtifact`,
`wpi.platforms.roborio` ↔ `wpi.platforms.linuxarm64`, `roborioDebug/Release` ↔
`vmxDebug/Release`. Comments and strings are left alone; the target keeps its name.
2020 VMX projects, Kotlin DSL and projects with several deploy targets are not supported.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Unit tests need neither VS Code nor a robot. With a JDK and the arm64 toolchain,
`node tools/smoke_release.js <gradlerio release dir> <allwpilib release dir>` installs
packaged releases through the extension code and builds Java and C++ projects with a
real Gradle (VMX-Pi and back to RoboRIO). Releases are packaged with
`tools/package_release.py`. Package the extension with `npx @vscode/vsce package`.

The command and release design follows the W4Studica (WPILib 2027) extension.

## Studica APIs in 2.0.5

Run `Update VMX2026 Version` to install allwpilib `2026.2.2-vmx.4` alongside
GradleRIO `2026.2.2-vmx.2`. On VMX targets, matching custom wpilibc and wpilibj
provide `studica` / `com.studica.frc` TitanQuad, TitanQuadEncoder, Cobra, Servo,
ServoContinuous and Lidar. Remove the original Titan 1.1.8 vendor dependency.
Switching back to RoboRIO selects upstream wpilibc/wpilibj. Older HAL-only
releases are supported. The custom C++ binary artifacts target linuxarm64;
desktop C++ simulation with the added classes requires a separate build.
See the [API setup guide](https://wsuser1101.github.io/vmxonwpi/guides/vmx-pi/studica-api/).
