import * as path from 'path';
import { realpathSync } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { Installation } from './releases';
import { exists, inside, io, writeTransaction } from './files';

export type Target = 'vmx' | 'roborio';
export interface ProjectState { schemaVersion: 1; target: Target; installation: Installation; projectStorageDir: string; }

/** ~/wpilib/2026/VMX2026: installed releases, per-project state and the shared Gradle hook. */
export function defaultHome(): string { return path.join(os.homedir(), 'wpilib', '2026', 'VMX2026'); }

const begin = '// BEGIN VMX2026 ';
const end = '// END VMX2026 ';

export function block(name: string, body: string): string { return begin + name + '\n' + body.trim() + '\n' + end + name; }

export function removeBlock(text: string, name: string): string {
    const marker = begin + name;
    let first = text.indexOf(marker);
    while (first >= 0 && !/^\r?\n/.test(text.slice(first + marker.length))) {
        first = text.indexOf(marker, first + marker.length);
    }
    if (first < 0) { return text; }
    const last = text.indexOf(end + name, first);
    if (last < 0) { throw new Error('Incomplete VMX2026 managed block: ' + name); }
    let start = first > 0 && text[first - 1] === '\n' ? first - 1 : first;
    if (start > 0 && text[start - 1] === '\r') { start--; }
    return text.slice(0, start) + text.slice(last + (end + name).length).replace(/^\r?\n/, '');
}

// Slashy literals occur where an expression can begin, or as a command argument.
// A slash following an expression (e.g. "value / 2") remains a division operator.
function startsSlashyString(prefix: string): boolean {
    const code = prefix.trimEnd();
    if (!code || /[=([{,:;!&|?~+*%<>-]$/.test(code) || /\b(return|case|assert|throw|in)\s*$/.test(code)) { return true; }
    const line = code.slice(code.lastIndexOf('\n') + 1).trim();
    return /^[A-Za-z_]\w*(?:[.]\w+)*$/.test(line);
}

// Preserve indices while hiding Groovy strings and comments from structural searches.
export function codeMask(text: string): string {
    const chars = text.split('');
    let i = 0;
    let lastLiteralEnd = -1;
    while (i < text.length) {
        const start = i;
        if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) { i = text.length; } }
        else if (text.startsWith('/*', i)) { const close = text.indexOf('*/', i + 2); if (close < 0) { throw new Error('Unclosed Gradle comment'); } i = close + 2; }
        else if (text.startsWith('$/', i)) {
            i += 2;
            let closed = false;
            while (i < text.length) {
                if (text[i] === '$' && (text[i + 1] === '$' || text[i + 1] === '/')) { i += 2; }
                else if (text.startsWith('/$', i)) { i += 2; closed = true; break; }
                else { i++; }
            }
            if (!closed) { throw new Error('Unclosed Gradle dollar-slashy string'); }
            lastLiteralEnd = i;
        }
        else if (text[i] === '/' && chars.slice(0, i).join('').trimEnd().length > lastLiteralEnd && startsSlashyString(chars.slice(0, i).join(''))) {
            i++;
            let closed = false;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; }
                else if (text[i] === '/') { i++; closed = true; break; }
                else { i++; }
            }
            if (!closed) { throw new Error('Unclosed Gradle slashy string'); }
            lastLiteralEnd = i;
        }
        else if (text[i] === "'" || text[i] === '"') {
            const quote = text.startsWith(text[i].repeat(3), i) ? text[i].repeat(3) : text[i];
            i += quote.length;
            let closed = false;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; }
                else if (text.startsWith(quote, i)) { i += quote.length; closed = true; break; }
                else { i++; }
            }
            if (!closed) { throw new Error('Unclosed Gradle string'); }
            lastLiteralEnd = i;
        } else { i++; continue; }
        for (let j = start; j < i; j++) { if (chars[j] !== '\n' && chars[j] !== '\r') { chars[j] = ' '; } }
    }
    return chars.join('');
}

function replaceCode(text: string, pattern: RegExp, replacement: (...args: any[]) => string): string {
    const mask = codeMask(text);
    return text.replace(pattern, (...args: any[]) => mask[args[args.length - 2]] === ' ' ? args[0] : replacement(...args));
}

const targetDeclaration = /\b\w+\s*\(\s*getTargetTypeClass\s*\(\s*(['"])(RoboRIO|VmxPi)\1\s*\)\s*\)\s*\{/g;

export function detectTarget(text: string): Target {
    const mask = codeMask(text);
    const found: Target[] = [];
    const pattern = new RegExp(targetDeclaration.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        if (mask[match.index] !== ' ') { found.push(match[2] === 'VmxPi' ? 'vmx' : 'roborio'); }
    }
    if (found.length !== 1) { throw new Error('Expected exactly one RoboRIO or VmxPi deploy target in a WPILib 2026 Groovy project.'); }
    return found[0];
}

/**
 * Names that differ between the two targets: [RoboRIO, VmxPi]. The deploy target keeps its own
 * name (for example "roborio"), so references such as deploy.targets.roborio keep working.
 * Both targets take the same team/debug settings, and the VmxPi login defaults to ubuntu/password.
 */
const renames: [RegExp, string, string][] = [
    [/\bgetTargetTypeClass\s*\(\s*(['"])(RoboRIO|VmxPi)\1\s*\)/g, "getTargetTypeClass('RoboRIO')", "getTargetTypeClass('VmxPi')"],
    [/\bgetArtifactTypeClass\s*\(\s*(['"])(FRCNativeArtifact|WPILibNativeArtifact)\1\s*\)/g, "getArtifactTypeClass('FRCNativeArtifact')", "getArtifactTypeClass('WPILibNativeArtifact')"],
    [/\bgetArtifactTypeClass\s*\(\s*(['"])(FRCJavaArtifact|WPILibJavaArtifact)\1\s*\)/g, "getArtifactTypeClass('FRCJavaArtifact')", "getArtifactTypeClass('WPILibJavaArtifact')"],
    [/\bwpi\.platforms\.(roborio|linuxarm64)\b/g, 'wpi.platforms.roborio', 'wpi.platforms.linuxarm64'],
    [/\b(roborio|vmx)Debug\b/g, 'roborioDebug', 'vmxDebug'],
    [/\b(roborio|vmx)Release\b/g, 'roborioRelease', 'vmxRelease'],
];

export function convertTarget(text: string, target: Target): string {
    if (detectTarget(text) === target) { return text; }
    for (const [pattern, roborio, vmx] of renames) {
        text = replaceCode(text, new RegExp(pattern.source, 'g'), () => target === 'vmx' ? vmx : roborio);
    }
    return text;
}

/** One line at the end of build.gradle loads the shared hook from the user's WPILib 2026 folder. */
export const applyLine = "apply from: new File(System.getProperty('user.home'), 'wpilib/2026/VMX2026/vmx2026.gradle')";

export function configureBuild(original: string, installation: Installation, target: Target): string {
    let text = original;
    const plugin = /\bid\s*(['"])edu\.wpi\.first\.GradleRIO\1(?:\s+version\s+(['"])[^'"\n]+\2)?/g;
    let pluginCount = 0;
    text = replaceCode(text, plugin, () => { pluginCount++; return 'id "edu.wpi.first.GradleRIO" version "' + installation.gradlerio.manifest.version + '"'; });
    if (pluginCount !== 1) { throw new Error('Expected edu.wpi.first.GradleRIO in a WPILib 2026 project. 2020 projects must be migrated first.'); }
    text = convertTarget(text, target);
    text = replaceCode(text, /\bapply from: new File\(System\.getProperty\('user\.home'\), 'wpilib\/2026\/VMX2026\/vmx2026\.gradle'\)[ \t]*(?:\r?\n|$)/gm, () => '');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    return text.replace(/[ \t\r\n]*$/, '') + newline + applyLine + newline;
}

export function configureSettings(original: string, installation: Installation): string {
    let text = removeBlock(original, 'plugin repositories');
    // Composite builds bypass plugin repositories and would select a source checkout instead of the release.
    if (/\bincludeBuild\s*\(/.test(codeMask(text))) { throw new Error('settings.gradle contains includeBuild. Remove the GradleRIO source-checkout connection before using prebuilt releases.'); }
    const url = pathToFileURL(inside(installation.gradlerio.directory, installation.gradlerio.manifest.mavenPath)).href;
    const managed = block('plugin repositories', `repositories {
    exclusiveContent {
        forRepository { maven { url = uri('${url}') } }
        filter {
            includeModule('edu.wpi.first.GradleRIO', 'edu.wpi.first.GradleRIO.gradle.plugin')
            includeModule('edu.wpi.first', 'GradleRIO')
        }
    }
    // GradleRIO's own dependencies
    gradlePluginPortal()
}`);
    const mask = codeMask(text);
    const match = /\bpluginManagement\s*\{/.exec(mask);
    if (match) {
        const open = match.index + match[0].lastIndexOf('{') + 1;
        text = text.slice(0, open) + '\n' + managed + '\n' + text.slice(open);
    } else { text = 'pluginManagement {\n' + managed + '\n}\n' + text; }
    return text;
}

export function projectStorageDir(root: string, home = defaultHome()): string {
    const key = createHash('sha256').update(realpathSync.native(root).replace(/\\/g, '/')).digest('hex');
    return path.join(home, 'projects', key);
}

/**
 * The shared hook applied by every connected project. It reads the project's state, points the
 * WPILib HAL (edu.wpi.first.hal) at the installed VMX HAL repository and version, and turns on
 * Gradle offline mode once Save Offline has verified the project.
 */
export const globalGradleScript = `import groovy.json.JsonSlurper
import java.security.MessageDigest
def vmxHome = new File(System.getProperty('user.home'), 'wpilib/2026/VMX2026')
def projectPath = project.rootDir.canonicalPath.replace('\\\\', '/')
def projectKey = MessageDigest.getInstance('SHA-256').digest(projectPath.getBytes('UTF-8')).encodeHex().toString()
def vmxProject = new File(vmxHome, 'projects/' + projectKey)
def stateFile = new File(vmxProject, 'config.json')
if (!stateFile.isFile()) throw new GradleException('VMX2026 project settings are missing. Reconnect the project with the VMX2026 extension.')
def state = new JsonSlurper().parse(stateFile)
def hal = state.installation.allwpilib
def halVersion = hal.manifest.version
wpi.versions.vmxHalVersion.set(halVersion)
repositories {
    exclusiveContent {
        forRepository { maven { url = new File(hal.directory, hal.manifest.mavenPath).toURI() } }
        filter { includeVersionByRegex('edu[.]wpi[.]first[.]hal', '.*', java.util.regex.Pattern.quote(halVersion)) }
    }
}
if (new File(vmxProject, 'offline').isFile() && System.getenv('VMX2026_ONLINE') != '1') gradle.startParameter.offline = true
`;

export async function readState(root: string, home = defaultHome()): Promise<ProjectState | undefined> {
    const file = path.join(projectStorageDir(root, home), 'config.json');
    if (!await exists(file)) { return undefined; }
    const state = JSON.parse(await io.readFile(file, 'utf8')) as ProjectState;
    if (state.schemaVersion !== 1 || !state.installation || !['vmx', 'roborio'].includes(state.target)) { throw new Error('Invalid VMX2026 project state'); }
    return state;
}

export async function configureProject(root: string, installation: Installation, target: Target, home = defaultHome()): Promise<void> {
    if (await exists(path.join(root, 'build.gradle.kts')) || await exists(path.join(root, 'settings.gradle.kts'))) { throw new Error('Only Groovy build.gradle/settings.gradle projects are supported.'); }
    const changes = new Map<string, string>();
    const buildFile = path.join(root, 'build.gradle');
    const settingsFile = path.join(root, 'settings.gradle');
    const originalBuild = await io.readFile(buildFile, 'utf8');
    const originalSettings = await exists(settingsFile) ? await io.readFile(settingsFile, 'utf8') : '';
    changes.set(buildFile, configureBuild(originalBuild, installation, target));
    changes.set(settingsFile, configureSettings(originalSettings, installation));
    const dataDir = projectStorageDir(root, home);
    const state: ProjectState = { schemaVersion: 1, target, installation, projectStorageDir: dataDir };
    changes.set(path.join(dataDir, 'config.json'), JSON.stringify(state, null, 2) + '\n');
    changes.set(path.join(home, 'vmx2026.gradle'), globalGradleScript);
    // One initial backup, for manual recovery; later target switches preserve user edits.
    for (const [name, contents] of [['build.gradle', originalBuild], ['settings.gradle', originalSettings]]) {
        const backup = path.join(dataDir, 'backup', name);
        if (!await exists(backup)) { changes.set(backup, contents); }
    }
    // Invalidate offline readiness before changing dependencies or target.
    const offline = path.join(dataDir, 'offline');
    if (await exists(offline)) { changes.set(offline, ''); }
    await writeTransaction(changes);
    if (changes.has(offline)) { await io.unlink(offline); }
}
