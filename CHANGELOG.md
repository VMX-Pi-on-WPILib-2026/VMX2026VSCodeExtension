# Changelog

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
