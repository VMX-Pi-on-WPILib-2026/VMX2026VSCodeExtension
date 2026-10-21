import * as path from 'path';
import { spawn } from 'child_process';
import { atomicWrite, exists, io } from './files';
import { codeMask, ProjectState } from './project';

export const resolveScript = `allprojects { project ->
    tasks.register('vmx2026ResolveOffline') {
        doLast {
            project.configurations.findAll { it.canBeResolved }.each { configuration ->
                logger.lifecycle('Saving configuration: ' + project.path + ':' + configuration.name)
                configuration.resolve()
            }
        }
    }
}
`;

/** cmd.exe splits on spaces: quote what contains them (project storage paths such as C:\Users\Jane Doe\...). */
export function quoteForCmd(argument: string): string {
    return /[\s"&|<>^()%!]/.test(argument) ? '"' + argument.replace(/"/g, '""') + '"' : argument;
}

export async function runGradle(root: string, args: string[], online: boolean, log: (text: string) => void): Promise<void> {
    const windows = process.platform === 'win32';
    const wrapper = path.join(root, windows ? 'gradlew.bat' : 'gradlew');
    if (!await exists(wrapper)) { throw new Error('Gradle wrapper not found: ' + wrapper); }
    log('Gradle: ' + args.join(' '));
    const child = windows
        ? spawn('cmd.exe', ['/d', '/s', '/c', '""' + wrapper + '" ' + args.map(quoteForCmd).join(' ') + '"'], { cwd: root, windowsVerbatimArguments: true, env: { ...process.env, VMX2026_ONLINE: online ? '1' : '0' } })
        : spawn('sh', [wrapper, ...args], { cwd: root, env: { ...process.env, VMX2026_ONLINE: online ? '1' : '0' } });
    child.stdout.on('data', data => log(data.toString()));
    child.stderr.on('data', data => log(data.toString()));
    await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error('Gradle failed (' + (signal || code) + '). See the VMX2026 output. Offline mode was not enabled.')));
    });
}

export async function saveOffline(root: string, state: ProjectState, log: (text: string) => void,
    run: typeof runGradle = runGradle): Promise<void> {
    const marker = path.join(state.projectStorageDir, 'offline');
    await io.unlink(marker).catch(error => { if (error.code !== 'ENOENT') { throw error; } });
    const script = path.join(state.projectStorageDir, 'resolve-offline.gradle');
    await atomicWrite(script, resolveScript);
    const buildFile = path.join(root, 'build.gradle');
    if (await exists(buildFile)) {
        const build = await io.readFile(buildFile, 'utf8');
        const cpp = /\bid\s*(['"])cpp\1/g;
        const mask = codeMask(build);
        let match: RegExpExecArray | null;
        while ((match = cpp.exec(build))) {
            if (mask[match.index] !== ' ') {
                await run(root, ['--no-daemon', state.target === 'vmx' ? 'installArm64Toolchain' : 'installRoboRioToolchain'], true, log);
                break;
            }
        }
    }
    await run(root, ['--no-daemon', '-I', script, 'vmx2026ResolveOffline'], true, log);
    await run(root, ['--no-daemon', 'build'], true, log);
    await run(root, ['--no-daemon', '--offline', '--rerun-tasks', 'build'], false, log);
    await atomicWrite(marker, JSON.stringify({ savedAt: new Date().toISOString(), target: state.target,
        gradlerio: state.installation.gradlerio.manifest.sha256, allwpilib: state.installation.allwpilib.manifest.sha256 }, null, 2));
    log('Offline build verified. Gradle cache cleanup is disabled for this project.');
}
