#!/usr/bin/env python3
"""Packages a built component into release ZIP(s) and vmx2026.json; it does not compile or publish.

  gradlerio: edu.wpi.first:GradleRIO and its plugin marker at --version
             (GradleRIO: ./gradlew publishToMavenLocal -PpublishVersion=V -Dmaven.repo.local=DIR)
  allwpilib: edu.wpi.first.hal:hal-cpp and hal-java at --version, the VMX HAL repository
             (allwpilib: python3 vmx/build_vmx_hal_maven.py --vmx-version V --output DIR)

Only those artifacts are taken from --maven, so one folder can hold both components.
Studica's VMX HAL library (libvmxpi_hal_cpp.so, VMXPi.h) must never be in a release.
"""
import argparse
import hashlib
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

COMPONENT_PATHS = {
    'gradlerio': ['edu/wpi/first/GradleRIO/{v}',
                  'edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin/{v}'],
    'allwpilib': ['edu/wpi/first/hal/hal-cpp/{v}',
                  'edu/wpi/first/hal/hal-java/{v}'],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('component', choices=sorted(COMPONENT_PATHS))
    parser.add_argument('--version', required=True, help='Maven version, e.g. 2026.2.2-vmx.1')
    parser.add_argument('--wpilib-version', required=True, help='WPILib release, e.g. 2026.2.2 (pairs the two components)')
    parser.add_argument('--maven', type=Path, required=True, help='Maven repository holding the built component')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--with-robot-libraries', action='store_true',
                        help='Include matching VMX wpilibc/wpilibj artifacts (allwpilib only)')
    parser.add_argument('--archive-size-mib', type=int, default=1400,
                        help='Maximum input size per independent ZIP (default: 1400 MiB)')
    args = parser.parse_args()
    if not 0 < args.archive_size_mib <= 1800:
        parser.error('--archive-size-mib must be between 1 and 1800')
    for value in [args.version, args.wpilib_version]:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+\-]*', value):
            parser.error('Invalid version')
    if not args.maven.is_dir():
        parser.error('--maven must be a built Maven repository directory')

    if args.with_robot_libraries:
        if args.component != 'allwpilib':
            parser.error('--with-robot-libraries requires allwpilib')
        COMPONENT_PATHS['allwpilib'] = COMPONENT_PATHS['allwpilib'] + [
            'edu/wpi/first/wpilibc/wpilibc-cpp/{v}',
            'edu/wpi/first/wpilibj/wpilibj-java/{v}']
    v = args.version
    if args.component == 'gradlerio':
        marker = args.maven / f'edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin/{v}/edu.wpi.first.GradleRIO.gradle.plugin-{v}.pom'
        implementation = args.maven / f'edu/wpi/first/GradleRIO/{v}/GradleRIO-{v}'
        if not marker.is_file():
            parser.error('GradleRIO plugin marker POM is missing')
        if not Path(str(implementation) + '.jar').is_file() or not Path(str(implementation) + '.pom').is_file():
            parser.error('GradleRIO implementation JAR or POM is missing')
    else:
        for artifact in ['hal-cpp', 'hal-java']:
            if not (args.maven / f'edu/wpi/first/hal/{artifact}/{v}/{artifact}-{v}.pom').is_file():
                parser.error(f'{artifact} {v} is missing')
        if not (args.maven / f'edu/wpi/first/hal/hal-cpp/{v}/hal-cpp-{v}-linuxarm64.zip').is_file():
            parser.error('The linuxarm64 VMX HAL is missing')

    args.output.mkdir(parents=True, exist_ok=True)
    name = f'vmx2026-{args.component}-{v}'
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for relative in COMPONENT_PATHS[args.component]:
            relative = relative.format(v=v)
            shutil.copytree(args.maven / relative, root / 'maven' / relative, symlinks=False)
        for file in root.rglob('*'):
            if file.name.startswith('libvmxpi_hal') or file.name == 'VMXPi.h':
                parser.error('Do not redistribute the VMX HAL library: ' + str(file.relative_to(root)))
            if file.suffix == '.zip':
                with zipfile.ZipFile(file) as inner:
                    if any(Path(n).name.startswith('libvmxpi_hal') for n in inner.namelist()):
                        parser.error('Do not redistribute the VMX HAL library (inside ' + file.name + ')')
        limit = args.archive_size_mib * 1024 * 1024
        groups, size = [[]], 0
        for file in sorted(p for p in root.rglob('*') if p.is_file()):
            length = file.stat().st_size
            if length > limit:
                parser.error('One Maven artifact exceeds the archive size limit: ' + file.name)
            if size + length > limit:
                groups.append([])
                size = 0
            groups[-1].append(file)
            size += length
        for old in args.output.glob(name + '*.zip'):
            old.unlink()
        archives = []
        for index, files in enumerate(groups):
            archive = args.output / (name + (f'-part{index + 1}' if index else '') + '.zip')
            with zipfile.ZipFile(archive, 'w', allowZip64=False) as output:
                for file in files:
                    compression = zipfile.ZIP_STORED if file.suffix in ['.zip', '.jar'] else zipfile.ZIP_DEFLATED
                    output.write(file, file.relative_to(root), compress_type=compression)
            with archive.open('rb') as stream:
                checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
            archives.append(dict(archive=archive.name, sha256=checksum))
    manifest = dict(schemaVersion=2 if len(archives) > 1 else 1, component=args.component, version=v,
                    wpilibVersion=args.wpilib_version, **archives[0], mavenPath='maven')
    if args.with_robot_libraries:
        manifest['robotLibraries'] = True
    if len(archives) > 1:
        manifest['additionalArchives'] = archives[1:]
    (args.output / 'vmx2026.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Upload {len(archives)} ZIP archive(s) and vmx2026.json to the {args.component} GitHub release.')


if __name__ == '__main__':
    main()
