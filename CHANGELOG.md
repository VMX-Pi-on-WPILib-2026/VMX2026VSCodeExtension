# Changelog

## 2.0.7

- Use allwpilib 2026.2.2-vmx.6, which fixes a VMX HAL buddy allocator crash in log capture.

Install this extension update, run `Update VMX2026 Version`, then redeploy the robot program.


## 2.0.6

- Pair with allwpilib 2026.2.2-vmx.5, which fixes the HAL initialization crash in `HAL_HandleEnum` lookup.

Install this extension update, run `Update VMX2026 Version`, then redeploy the robot program.


## 2.0.5

- Use allwpilib 2026.2.2-vmx.4, which provides the HALSIM symbols required by the matching WPILib C++ runtime on VMX hardware.

Install this extension update, run `Update VMX2026 Version`, then redeploy the robot program.


## 2.0.4

- Install matching custom wpilibc and wpilibj from releases declaring `robotLibraries`.
- Select those libraries for VMX targets so C++ `studica` and Java `com.studica.frc` APIs are available without the old Titan vendor dependency.
- Restore upstream wpilibc/wpilibj when switching back to RoboRIO; retain support for older HAL-only releases.

Use GradleRIO 2026.2.2-vmx.2 with allwpilib 2026.2.2-vmx.3.
The bundled native Studica APIs target linuxarm64; desktop C++ simulation with these classes is not included.

## 2.0.3

- Pin the extension repository metadata and default GradleRIO/VMX HAL repositories to `VMXONWPI`.

Compatible with the GradleRIO and VMX HAL 2026.2.2-vmx.2 release pair.

## 2.0.2

- Deploy static files into the VMX-pi login user's deploy directory when switching from RoboRIO.
- Restore the RoboRIO static-file path when switching back.

Compatible with the GradleRIO and VMX HAL 2026.2.2-vmx.2 release pair.

## 2.0.1

- Preserve user Gradle statements and line endings when updating the managed hook.
- Preserve Groovy slashy and dollar-slashy strings when switching deploy targets.
- Use canonical project paths so symlinked projects share the correct settings.
- Test packaged HAL releases using the version declared by their manifests.

Compatible with the GradleRIO and VMX HAL 2026.2.2-vmx.2 release pair.
