import * as vscode from 'vscode';
import * as path from 'path';
import { candidateDownloadSize, findInstallation, Installation, installComponent, InstallProgress } from './releases';
import { configureProject, defaultHome, detectTarget, readState, Target } from './project';
import { saveOffline } from './offline';
import { io } from './files';

function installationIsInHome(installation: Installation, home: string): boolean {
    const releaseRoot = path.resolve(home, 'releases') + path.sep;
    return [installation.gradlerio.directory, installation.allwpilib.directory].every(directory => path.resolve(directory).startsWith(releaseRoot));
}

function targetName(target: Target): string { return target === 'vmx' ? 'VMX-Pi' : 'RoboRIO'; }

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('VMX2026');
    context.subscriptions.push(output);
    const busy = new Set<string>();

    async function workspace(): Promise<vscode.WorkspaceFolder | undefined> {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before modifying or running its Gradle build.'); }
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) { throw new Error('Open a WPILib 2026 project folder first.'); }
        if (folders.length === 1) { return folders[0]; }
        const selected = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: 'Select the robot project' });
        return selected && selected.folder;
    }

    async function install(folder: vscode.WorkspaceFolder, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<Installation> {
        const settings = vscode.workspace.getConfiguration('vmx2026', folder.uri);
        progress.report({ message: 'Checking compatible VMX releases…' });
        const pair = await findInstallation({
            gradlerio: settings.get<string>('gradleRIORepository', 'VMX-Pi-on-WPILib-2026/GradleRIO'),
            allwpilib: settings.get<string>('allwpilibRepository', 'VMX-Pi-on-WPILib-2026/allwpilib')
        }, settings.get<boolean>('includePrereleases', true));
        const log = (text: string) => output.appendLine(text);
        const downloads = [pair.gradlerio, pair.allwpilib];
        const sizes = downloads.map(candidateDownloadSize);
        const totalSize = sizes.reduce((sum, size) => sum + size, 0);
        const startedAt = Date.now();
        let completedBytes = 0;
        let reportedPercent = 0;
        const onProgress = (index: number) => (state: InstallProgress) => {
            const size = sizes[index];
            const current = state.cached ? size : size > 0 && state.total > 0 ? size * Math.min(1, state.transferred / state.total) : 0;
            const bytesDone = Math.min(totalSize, completedBytes + current);
            const percent = totalSize > 0 ? Math.min(90, Math.floor(bytesDone / totalSize * 90)) : 0;
            const seconds = (Date.now() - startedAt) / 1000;
            const speed = seconds > 1 ? bytesDone / seconds : 0;
            const remaining = speed > 0 ? Math.ceil((totalSize - bytesDone) / speed) : undefined;
            const eta = remaining === undefined ? 'estimating time…' : remaining < 60 ? `about ${remaining}s left` : `about ${Math.floor(remaining / 60)}m ${remaining % 60}s left`;
            const label = state.component === 'gradlerio' ? 'GradleRIO' : 'VMX HAL';
            const detail = state.cached ? `${label} already installed` : `${percent}% · ${eta} · ${label}${state.archive ? ' — ' + state.archive : ''}`;
            progress.report({ increment: Math.max(0, percent - reportedPercent), message: detail });
            reportedPercent = Math.max(reportedPercent, percent);
        };
        const home = defaultHome();
        const gradlerio = await installComponent(pair.gradlerio, home, log, undefined, onProgress(0));
        completedBytes += sizes[0];
        const allwpilib = await installComponent(pair.allwpilib, home, log, undefined, onProgress(1));
        completedBytes += sizes[1];
        progress.report({ increment: Math.max(0, 100 - reportedPercent), message: 'Downloads verified and installed' });
        return { gradlerio, allwpilib };
    }

    function command(id: string, action: (folder: vscode.WorkspaceFolder, progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<void>): void {
        context.subscriptions.push(vscode.commands.registerCommand('vmx2026.' + id, async () => {
            let root: string | undefined;
            let acquired = false;
            try {
                const folder = await workspace();
                if (!folder) { return; }
                root = folder.uri.fsPath;
                if (busy.has(root)) { throw new Error('Another VMX2026 operation is running for this project.'); }
                const dirty = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.fsPath.startsWith(root + path.sep));
                if (dirty.length) { throw new Error('Save the project files before running VMX2026 commands.'); }
                busy.add(root);
                acquired = true;
                output.show(true);
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VMX2026', cancellable: false }, progress => action(folder, progress));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(message);
                vscode.window.showErrorMessage('VMX2026: ' + message);
            } finally { if (root && acquired) { busy.delete(root); } }
        }));
    }

    async function changeTarget(folder: vscode.WorkspaceFolder, target: Target, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        const root = folder.uri.fsPath;
        const home = defaultHome();
        const old = await readState(root, home);
        const current = detectTarget(await io.readFile(path.join(root, 'build.gradle'), 'utf8'));
        if (current === target && old && old.target === target) { vscode.window.showInformationMessage('The deploy target is already ' + targetName(target) + '.'); return; }
        // Switching reuses the installed release pair, so it works without GitHub access.
        const installation = old && installationIsInHome(old.installation, home) ? old.installation : await install(folder, progress);
        await configureProject(root, installation, target, home);
        vscode.window.showInformationMessage('Deploy target changed to ' + targetName(target) + '. Run Save VMX2026 Offline again to prepare dependencies for this target.');
    }

    command('setVMXPiTarget', (folder, progress) => changeTarget(folder, 'vmx', progress));
    command('setRoboRIOTarget', (folder, progress) => changeTarget(folder, 'roborio', progress));
    command('updateVersion', async (folder, progress) => {
        const root = folder.uri.fsPath;
        const home = defaultHome();
        const current = await readState(root, home);
        const installation = await install(folder, progress);
        const target = detectTarget(await io.readFile(path.join(root, 'build.gradle'), 'utf8'));
        if (current && current.target === target && JSON.stringify(current.installation) === JSON.stringify(installation)) {
            vscode.window.showInformationMessage('VMX2026 is already up to date.');
            return;
        }
        await configureProject(root, installation, target, home);
        vscode.window.showInformationMessage('VMX2026 updated: GradleRIO ' + installation.gradlerio.manifest.version + ', VMX HAL ' + installation.allwpilib.manifest.version + '. Run Save VMX2026 Offline to refresh offline dependencies.');
    });
    command('saveOffline', async (folder, progress) => {
        const root = folder.uri.fsPath;
        const home = defaultHome();
        let state = await readState(root, home);
        if (!state) { throw new Error('Run Update VMX2026 Version or change the deploy target first.'); }
        if (detectTarget(await io.readFile(path.join(root, 'build.gradle'), 'utf8')) !== state.target) {
            throw new Error('The deploy target changed outside VMX2026. Run Update VMX2026 Version to reconnect this project before saving offline.');
        }
        if (!installationIsInHome(state.installation, home)) {
            const installation = await install(folder, progress);
            await configureProject(root, installation, state.target, home);
            state = await readState(root, home);
            if (!state) { throw new Error('Could not save VMX2026 project settings.'); }
        }
        await saveOffline(root, state, text => output.appendLine(text));
        vscode.window.showInformationMessage('VMX2026 saved for offline use. Later project builds will use the saved dependencies. Re-run this command after changing dependencies.');
    });
    context.subscriptions.push(vscode.commands.registerCommand('vmx2026.openCommandPalette', () => vscode.commands.executeCommand('workbench.action.quickOpen', '>VMX2026: ')));
}

export function deactivate(): void { /* VS Code disposes registered commands and the output channel. */ }
