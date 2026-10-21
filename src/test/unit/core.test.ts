import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { deflateRawSync } from 'zlib';
import { Readable } from 'stream';
import { Response } from 'node-fetch';
import { applyLine, configureBuild, configureProject, configureSettings, detectTarget, globalGradleScript, ProjectState, projectStorageDir, readState } from '../../project';
import { Candidate, candidateDownloadSize, findInstallation, Installation, installComponent, Manifest, manifestAssetName, validateManifest } from '../../releases';
import { atomicWrite, exists, inside, io, writeTransaction } from '../../files';
import { extractZip } from '../../archive';
import { quoteForCmd, runGradle, saveOffline } from '../../offline';

// The WPILib 2026 C++ template (RoboRIO target), with a few traps in comments and strings.
const roborio = `plugins {
    id "cpp"
    id "google-test-test-suite"
    id "edu.wpi.first.GradleRIO" version "2026.2.1"
}
// roborioDebug and wpi.platforms.roborio in comments must survive.
def label = "wpi.platforms.roborio { }"
deploy {
    targets {
        roborio(getTargetTypeClass('RoboRIO')) {
            team = project.frc.getTeamNumber()
            debug = project.frc.getDebugOrDefault(false)
            artifacts {
                frcCpp(getArtifactTypeClass('FRCNativeArtifact')) {
                }
                frcStaticFileDeploy(getArtifactTypeClass('FileTreeArtifact')) {
                    files = project.fileTree('src/main/deploy')
                    directory = '/home/lvuser/deploy'
                }
            }
        }
    }
}
def deployArtifact = deploy.targets.roborio.artifacts.frcCpp
model {
    components {
        frcUserProgram(NativeExecutableSpec) {
            targetPlatform wpi.platforms.roborio
            targetPlatform wpi.platforms.desktop
            sources.cpp { source { srcDir 'src/main/cpp' }; exportedHeaders { srcDir 'src/main/include' } }
            deployArtifact.component = it
            wpi.cpp.deps.wpilib(it)
        }
    }
}
`;

const javaProject = roborio.replace('id "cpp"', 'id "java"').replace("'FRCNativeArtifact'", "'FRCJavaArtifact'") +
    '\ndependencies {\n    roborioDebug wpi.java.deps.wpilibJniDebug(wpi.platforms.roborio)\n    roborioRelease wpi.java.deps.wpilibJniRelease(wpi.platforms.roborio)\n}\n';

function installed(component: 'gradlerio' | 'allwpilib') {
    return {
        repository: 'VMX-Pi-on-WPILib-2026/' + (component === 'gradlerio' ? 'GradleRIO' : 'allwpilib'),
        directory: path.resolve(os.tmpdir(), 'vmx2026 test', component),
        release: { tag_name: 'v2026.2.2-vmx.1', draft: false, prerelease: false, assets: [] },
        manifest: { schemaVersion: 1, component, version: '2026.2.2-vmx.1', wpilibVersion: '2026.2.2',
            archive: 'bundle.zip', sha256: 'a'.repeat(64), mavenPath: 'maven' } as Manifest
    };
}
const installation: Installation = { gradlerio: installed('gradlerio'), allwpilib: installed('allwpilib') };

// Test ZIP writer; no CRC is needed by our reader (the release's SHA-256 authenticates the full archive).
function zip(entries: { name: string; content: string; symlink?: boolean; declared?: number }[]): Buffer {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const data = Buffer.from(entry.content);
        const compressed = deflateRawSync(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(8, 8);
        header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.declared === undefined ? data.length : entry.declared, 22);
        header.writeUInt16LE(name.length, 26);
        locals.push(header, name, compressed);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(8, 10);
        record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(entry.declared === undefined ? data.length : entry.declared, 24);
        record.writeUInt16LE(name.length, 28); record.writeUInt32LE(entry.symlink ? 0xa0000000 : 0, 38); record.writeUInt32LE(offset, 42);
        central.push(record, name);
        offset += header.length + name.length + compressed.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

suite('Project conversion', () => {
    test('VMX conversion keeps target references, comments, strings and desktop simulation', () => {
        const converted = configureBuild(roborio, installation, 'vmx');
        assert.strictEqual(detectTarget(converted), 'vmx');
        assert.ok(converted.includes("roborio(getTargetTypeClass('VmxPi'))"));
        assert.ok(converted.includes("getArtifactTypeClass('WPILibNativeArtifact')"));
        assert.ok(converted.includes("getArtifactTypeClass('FileTreeArtifact')"));
        assert.ok(converted.includes('deploy.targets.roborio.artifacts.frcCpp'));
        assert.ok(converted.includes('targetPlatform wpi.platforms.linuxarm64'));
        assert.ok(converted.includes('targetPlatform wpi.platforms.desktop'));
        assert.ok(converted.includes('// roborioDebug and wpi.platforms.roborio in comments'));
        assert.ok(converted.includes('"wpi.platforms.roborio { }"'));
        assert.ok(converted.includes('id "edu.wpi.first.GradleRIO" version "2026.2.2-vmx.1"'));
        assert.ok(converted.endsWith(applyLine + '\n'));
        assert.ok(!converted.includes('exclusiveContent'));
    });
    test('RoboRIO return restores the template names and keeps edits made while on VMX', () => {
        const vmx = configureBuild(roborio, installation, 'vmx') + '\ndef customUserSetting = 42\n';
        const restored = configureBuild(vmx, installation, 'roborio');
        assert.strictEqual(detectTarget(restored), 'roborio');
        assert.ok(restored.includes("roborio(getTargetTypeClass('RoboRIO'))"));
        assert.ok(restored.includes("getArtifactTypeClass('FRCNativeArtifact')"));
        assert.ok(restored.includes('targetPlatform wpi.platforms.roborio'));
        assert.ok(!restored.includes('wpi.platforms.linuxarm64'));
        assert.ok(restored.includes('customUserSetting = 42'));
        assert.strictEqual(restored.split(applyLine).length, 2);
    });
    test('Java artifact and JNI configurations switch in both directions', () => {
        const vmx = configureBuild(javaProject, installation, 'vmx');
        assert.ok(vmx.includes("getArtifactTypeClass('WPILibJavaArtifact')"));
        assert.ok(vmx.includes('vmxDebug wpi.java.deps.wpilibJniDebug(wpi.platforms.linuxarm64)'));
        assert.ok(vmx.includes('vmxRelease wpi.java.deps.wpilibJniRelease(wpi.platforms.linuxarm64)'));
        const back = configureBuild(vmx, installation, 'roborio');
        assert.ok(back.includes("getArtifactTypeClass('FRCJavaArtifact')"));
        assert.ok(back.includes('roborioRelease wpi.java.deps.wpilibJniRelease(wpi.platforms.roborio)'));
    });
    test('repeated updates do not duplicate the hook', () => {
        let text = configureBuild(roborio, installation, 'vmx');
        const first = text;
        for (let i = 0; i < 3; i++) { text = configureBuild(text, installation, 'vmx'); }
        assert.strictEqual(text, first);
    });
    test('CRLF files round trip and managed settings are replaced, not duplicated', () => {
        const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
        const vmx = configureBuild(crlf(roborio), installation, 'vmx');
        assert.ok(vmx.endsWith(applyLine + '\r\n'));
        const restored = configureBuild(crlf(vmx), installation, 'roborio');
        assert.strictEqual(detectTarget(restored), 'roborio');
        assert.strictEqual(restored.split(applyLine).length, 2);
        const settings = crlf(configureSettings("rootProject.name = 'Robot'\r\n", installation));
        assert.strictEqual(configureSettings(settings, installation).split('BEGIN VMX2026 plugin repositories').length, 2);
    });
    test('settings keep the root name and existing plugin repositories; the release repository comes first', () => {
        const original = "pluginManagement { repositories { mavenCentral() } }\nrootProject.name = 'Robot'";
        const result = configureSettings(configureSettings(original, installation), installation);
        assert.strictEqual(result.split('BEGIN VMX2026 plugin repositories').length, 2);
        assert.ok(result.indexOf('/maven') < result.indexOf('mavenCentral()'));
        assert.ok(result.includes("includeModule('edu.wpi.first', 'GradleRIO')"));
        assert.ok(result.includes("rootProject.name = 'Robot'"));
    });
    test('removing a hook preserves the following user statement and CRLF line boundaries', () => {
        for (const newline of ['\n', '\r\n']) {
            const first = configureBuild(roborio.replace(/\n/g, newline), installation, 'vmx');
            const modified = first + 'def answer = 42' + newline;
            const converted = configureBuild(modified, installation, 'roborio');
            assert.ok(converted.includes('}' + newline + 'def answer = 42'));
            assert.strictEqual(converted.split(applyLine).length, 2);
        }
    });
    test('slashy, dollar-slashy and command strings survive target conversion', () => {
        const literals = [
            'def pattern = /wpi.platforms.roborio/',
            'def pattern2 = ~ /roborioDebug/',
            'def multiline = /start\nwpi.platforms.roborio\nend/',
            'def dollars = $/wpi.platforms.roborio $$$$ $/ /$',
            'println /wpi.platforms.roborio/',
            'def escaped = /prefix\\/wpi.platforms.roborio/',
            "def division = 'literal'.length() / 2",
            "def division2 = 'literal' / 2",
            'def ratio = 8 / 2',
            'def platformRatio = wpi.platforms.roborio / 2'
        ];
        const converted = configureBuild(roborio + literals.join('\n') + '\n', installation, 'vmx');
        for (const literal of literals.slice(0, -1)) { assert.ok(converted.includes(literal), literal); }
        assert.ok(converted.includes('def platformRatio = wpi.platforms.linuxarm64 / 2'));
    });
    test('2020 projects, multiple targets and source builds fail before conversion', () => {
        assert.throws(() => configureBuild(roborio.replace('edu.wpi.first.GradleRIO', 'com.kauailabs.first.GradleRIO'), installation, 'vmx'), /2026/);
        assert.throws(() => detectTarget(roborio + roborio), /exactly one/);
        assert.throws(() => configureSettings("pluginManagement { includeBuild('../GradleRIO') }", installation), /includeBuild/);
    });
    test('the shared hook selects the installed VMX HAL version for edu.wpi.first.hal only', () => {
        assert.ok(globalGradleScript.includes('wpi.versions.vmxHalVersion.set(halVersion)'));
        assert.ok(globalGradleScript.includes("includeVersionByRegex('edu[.]wpi[.]first[.]hal'"));
        assert.ok(globalGradleScript.includes("'wpilib/2026/VMX2026'"));
    });
});

suite('Command menu', () => {
    test('exposes the four commands and none of the 2020 ones', async () => {
        const manifest = JSON.parse(await io.readFile(path.resolve(__dirname, '../../../package.json'), 'utf8'));
        const titles = manifest.contributes.commands.map((command: { title: string }) => command.title);
        for (const title of ['Change the deploy target to VMX-Pi (from RoboRIO)', 'Change the deploy target to RoboRIO (from VMX-Pi)',
            'Update VMX2026 Version', 'Save VMX2026 Offline']) { assert.ok(titles.includes(title), title); }
        assert.ok(!manifest.activationEvents.some((event: string) => /updateWPILib|checkGradleStatus/.test(event)));
    });
});

suite('Release and archive validation', () => {
    let temp: string;
    setup(async () => { temp = await io.mkdtemp(path.join(os.tmpdir(), 'vmx2026-')); });
    teardown(async () => { await io.rm(temp, { recursive: true }); });
    test('rejects invalid manifests and traversal paths', () => {
        assert.throws(() => validateManifest({}, 'gradlerio'), /Invalid/);
        assert.throws(() => validateManifest({ ...installation.allwpilib.manifest, mavenPath: '../outside' }, 'allwpilib'), /escapes/);
        for (const name of ['../outside', '/absolute', 'C:\\escape', '..\\escape']) { assert.throws(() => inside(temp, name)); }
    });
    test('extracts deflated Maven files and rejects traversal, symlinks, duplicates and expansion mismatches', async () => {
        const archive = path.join(temp, 'bundle.zip');
        await io.writeFile(archive, zip([{ name: 'maven/lib.pom', content: 'pom' }]));
        await extractZip(archive, path.join(temp, 'good'));
        assert.strictEqual(await io.readFile(path.join(temp, 'good/maven/lib.pom'), 'utf8'), 'pom');
        for (const [index, entries] of [
            [{ name: '../escape', content: 'x' }],
            [{ name: 'link', content: '../escape', symlink: true }],
            [{ name: 'same', content: 'a' }, { name: 'same', content: 'b' }],
            [{ name: 'small', content: 'much too big', declared: 1 }]
        ].entries()) {
            await io.writeFile(archive, zip(entries));
            await assert.rejects(extractZip(archive, path.join(temp, 'bad' + index)));
        }
    });
    test('selects compatible releases from both repos and honours the prerelease setting', async () => {
        const repos = { gradlerio: 'VMX-Pi-on-WPILib-2026/GradleRIO', allwpilib: 'VMX-Pi-on-WPILib-2026/allwpilib' };
        const makeRelease = (tag: string, prerelease = false) => ({ tag_name: tag, draft: false, prerelease, assets: [{ name: manifestAssetName, browser_download_url: 'https://github.com/test/repo/releases/download/' + tag + '/' + manifestAssetName }] });
        const request = async (url: string) => {
            if (url.includes('/GradleRIO/releases')) { return [makeRelease('new', true), makeRelease('old')]; }
            if (url.includes('/allwpilib/releases')) { return [makeRelease('hal')]; }
            const component = url.includes('/hal/') ? 'allwpilib' : 'gradlerio';
            return { ...installed(component).manifest, wpilibVersion: url.includes('/new/') ? 'unmatched' : '2026.2.2' };
        };
        const result = await findInstallation(repos, true, request);
        assert.strictEqual(result.gradlerio.release.tag_name, 'old');
        assert.strictEqual(result.allwpilib.release.tag_name, 'hal');
        assert.strictEqual((await findInstallation(repos, false, request)).gradlerio.release.tag_name, 'old');
        await assert.rejects(findInstallation(repos, false, async () => []), /No compatible/);
    });
    test('GradleRIO: installs only checksum-verified complete archives, caches, rejects a bad checksum', async () => {
        const manifest = installation.gradlerio.manifest;
        const marker = 'maven/edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin/' + manifest.version + '/edu.wpi.first.GradleRIO.gradle.plugin-' + manifest.version + '.pom';
        const implementation = 'maven/edu/wpi/first/GradleRIO/' + manifest.version + '/GradleRIO-' + manifest.version;
        const archive = zip([{ name: marker, content: '<project/>' }, { name: implementation + '.pom', content: '<project/>' }, { name: implementation + '.jar', content: 'fixture' }]);
        const candidate: Candidate = { ...installed('gradlerio'), manifest: { ...manifest, sha256: createHash('sha256').update(archive).digest('hex') },
            release: { ...installed('gradlerio').release, assets: [{ name: 'bundle.zip', size: archive.length, browser_download_url: 'https://github.com/VMX-Pi-on-WPILib-2026/GradleRIO/releases/download/v1/bundle.zip' }] } };
        assert.strictEqual(candidateDownloadSize(candidate), archive.length);
        let calls = 0;
        const updates: { transferred: number; total: number; cached?: boolean }[] = [];
        const download = async () => { calls++; return new Response(Readable.from([archive])); };
        const result = await installComponent(candidate, temp, () => undefined, download, update => updates.push(update));
        assert.ok(await exists(path.join(result.directory, '.complete')));
        assert.ok(updates.some(update => update.total === archive.length && update.transferred === archive.length));
        await installComponent(candidate, temp, () => undefined, download, update => updates.push(update));
        assert.ok(updates.some(update => update.cached));
        assert.strictEqual(calls, 1);
        await assert.rejects(installComponent({ ...candidate, manifest: { ...manifest, sha256: 'b'.repeat(64) } }, temp, () => undefined, download), /SHA-256/);
    });
    test('VMX HAL: the archive must contain hal-cpp (with linuxarm64) and hal-java at the release version', async () => {
        const manifest = installation.allwpilib.manifest;
        const v = manifest.version;
        const entries = [
            { name: `maven/edu/wpi/first/hal/hal-cpp/${v}/hal-cpp-${v}.pom`, content: '<project/>' },
            { name: `maven/edu/wpi/first/hal/hal-cpp/${v}/hal-cpp-${v}-linuxarm64.zip`, content: 'zip' },
            { name: `maven/edu/wpi/first/hal/hal-java/${v}/hal-java-${v}.pom`, content: '<project/>' }
        ];
        const make = (files: typeof entries): Candidate => {
            const archive = zip(files);
            return { ...installed('allwpilib'), manifest: { ...manifest, sha256: createHash('sha256').update(archive).digest('hex') },
                release: { ...installed('allwpilib').release, assets: [{ name: 'bundle.zip', size: archive.length, browser_download_url: 'https://github.com/VMX-Pi-on-WPILib-2026/allwpilib/releases/download/v1/bundle.zip' }] },
                archive } as Candidate & { archive: Buffer };
        };
        const good = make(entries) as Candidate & { archive: Buffer };
        const result = await installComponent(good, temp, () => undefined, async () => new Response(Readable.from([good.archive])));
        assert.ok(await exists(path.join(result.directory, 'maven/edu/wpi/first/hal/hal-java', v)));
        const noArm = make(entries.filter(e => !e.name.endsWith('-linuxarm64.zip'))) as Candidate & { archive: Buffer };
        await assert.rejects(installComponent({ ...noArm, repository: 'other/allwpilib' }, temp, () => undefined, async () => new Response(Readable.from([noArm.archive]))), /linuxarm64/);
    });
});

suite('Offline and atomic project operations', () => {
    let temp: string;
    let home: string;
    setup(async () => { temp = await io.mkdtemp(path.join(os.tmpdir(), 'vmx2026 project ')); });
    setup(async () => { home = await io.mkdtemp(path.join(os.tmpdir(), 'vmx2026 home ')); });
    teardown(async () => { await io.rm(temp, { recursive: true }); await io.rm(home, { recursive: true }); });
    test('writes project state, hook and backup, invalidates offline on switch, leaves sources intact', async () => {
        await io.writeFile(path.join(temp, 'build.gradle'), roborio);
        await io.writeFile(path.join(temp, 'gradlew'), '#!/bin/sh\nexec "$JAVACMD" "$@"\n', { mode: 0o755 });
        await atomicWrite(path.join(temp, 'src/main/cpp/robot.cpp'), '// user robot');
        await configureProject(temp, installation, 'vmx', home);
        assert.strictEqual((await io.stat(path.join(temp, 'gradlew'))).mode & 0o777, 0o755);
        const state = (await readState(temp, home))!;
        assert.strictEqual(state.target, 'vmx');
        assert.strictEqual(await io.readFile(path.join(state.projectStorageDir, 'backup/build.gradle'), 'utf8'), roborio);
        assert.strictEqual(await io.readFile(path.join(home, 'vmx2026.gradle'), 'utf8'), globalGradleScript);
        assert.ok((await io.readFile(path.join(temp, 'settings.gradle'), 'utf8')).includes('BEGIN VMX2026 plugin repositories'));
        await atomicWrite(path.join(state.projectStorageDir, 'offline'), '{}');
        await configureProject(temp, installation, 'roborio', home);
        assert.ok(!await exists(path.join(state.projectStorageDir, 'offline')));
        assert.strictEqual(detectTarget(await io.readFile(path.join(temp, 'build.gradle'), 'utf8')), 'roborio');
        assert.strictEqual(await io.readFile(path.join(temp, 'src/main/cpp/robot.cpp'), 'utf8'), '// user robot');
    });
    test('symlink and real project paths share configuration, backup and offline storage', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const real = path.join(temp, 'robot');
        const link = path.join(temp, 'linked robot');
        await io.mkdir(real);
        await io.symlink(real, link);
        await io.writeFile(path.join(real, 'build.gradle'), roborio);
        await configureProject(link, installation, 'vmx', home);
        assert.strictEqual(projectStorageDir(link, home), projectStorageDir(real, home));
        assert.strictEqual((await readState(real, home))!.target, 'vmx');
        await configureProject(real, installation, 'roborio', home);
        assert.strictEqual((await readState(link, home))!.target, 'roborio');
    });
    test('failed preparation never changes build.gradle', async () => {
        await io.writeFile(path.join(temp, 'build.gradle'), roborio);
        await io.writeFile(path.join(temp, 'settings.gradle'), "includeBuild('../GradleRIO')");
        await assert.rejects(configureProject(temp, installation, 'vmx', home), /includeBuild/);
        assert.strictEqual(await io.readFile(path.join(temp, 'build.gradle'), 'utf8'), roborio);
        assert.ok(!await exists(path.join(projectStorageDir(temp, home), 'config.json')));
    });
    test('transaction restores an earlier write if a later parent is unwritable', async () => {
        const good = path.join(temp, 'good');
        await io.writeFile(good, 'before');
        const parent = path.join(temp, 'parent');
        await io.writeFile(parent, 'file, not directory');
        await assert.rejects(writeTransaction(new Map([[good, 'after'], [path.join(parent, 'child'), 'fail']])));
        assert.strictEqual(await io.readFile(good, 'utf8'), 'before');
    });
    test('marks offline ready only after toolchain, resolution, build and forced offline build succeed', async () => {
        await io.writeFile(path.join(temp, 'build.gradle'), configureBuild(roborio, installation, 'vmx'));
        const state: ProjectState = { schemaVersion: 1, target: 'vmx', installation, projectStorageDir: projectStorageDir(temp, home) };
        const calls: { args: string[]; online: boolean }[] = [];
        await saveOffline(temp, state, () => undefined, async (_root, args, online) => { calls.push({ args, online }); });
        assert.strictEqual(calls.length, 4);
        assert.ok(calls[0].args.includes('installArm64Toolchain'));
        assert.deepStrictEqual(calls.map(c => c.online), [true, true, true, false]);
        assert.ok(calls[3].args.includes('--offline') && calls[3].args.includes('--rerun-tasks'));
        assert.ok(await exists(path.join(state.projectStorageDir, 'offline')));
        await assert.rejects(saveOffline(temp, state, () => undefined, async () => { throw new Error('Missing dependency'); }), /Missing dependency/);
        assert.ok(!await exists(path.join(state.projectStorageDir, 'offline')));
    });
    test('RoboRIO C++ projects install the roboRIO toolchain', async () => {
        await io.writeFile(path.join(temp, 'build.gradle'), roborio);
        const state: ProjectState = { schemaVersion: 1, target: 'roborio', installation, projectStorageDir: projectStorageDir(temp, home) };
        const calls: string[][] = [];
        await saveOffline(temp, state, () => undefined, async (_root, args) => { calls.push(args); });
        assert.ok(calls[0].includes('installRoboRioToolchain'));
    });
    test('runs the Unix wrapper in a path with spaces and reports build failure', async function () {
        if (process.platform === 'win32') { this.skip(); }
        await io.writeFile(path.join(temp, 'gradlew'), '#!/bin/sh\n[ "$VMX2026_ONLINE" = 1 ] && [ "$1" = build ]\n');
        await runGradle(temp, ['build'], true, () => undefined);
        await assert.rejects(runGradle(temp, ['build'], false, () => undefined), /Gradle failed/);
    });
    test('quoteForCmd quotes arguments that cmd.exe would split', () => {
        assert.strictEqual(quoteForCmd('build'), 'build');
        assert.strictEqual(quoteForCmd('C:\\Users\\Jane Doe\\resolve-offline.gradle'), '"C:\\Users\\Jane Doe\\resolve-offline.gradle"');
        assert.strictEqual(quoteForCmd('a"b'), '"a""b"');
    });
});
