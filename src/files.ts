import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

export const io = fs.promises;

export async function exists(file: string): Promise<boolean> {
    try { await io.access(file); return true; } catch { return false; }
}

export function inside(root: string, relative: string): string {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':') || path.posix.isAbsolute(relative)) {
        throw new Error('Invalid bundle path: ' + relative);
    }
    const result = path.resolve(root, relative);
    if (!result.startsWith(path.resolve(root) + path.sep)) { throw new Error('Bundle path escapes its directory: ' + relative); }
    return result;
}

export async function atomicWrite(file: string, data: string): Promise<void> {
    await io.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    const mode = await io.stat(file).then(stat => stat.mode & 0o777).catch(() => 0o644);
    try { await io.writeFile(temp, data, { mode }); await io.rename(temp, file); }
    finally { await io.unlink(temp).catch(() => undefined); }
}

// Prepare every change before committing. Roll back earlier writes if a later one fails.
export async function writeTransaction(changes: Map<string, string>): Promise<void> {
    const originals = new Map<string, string | undefined>();
    for (const file of changes.keys()) {
        originals.set(file, await exists(file) ? await io.readFile(file, 'utf8') : undefined);
    }
    const written: string[] = [];
    try {
        for (const [file, value] of changes) { await atomicWrite(file, value); written.push(file); }
    } catch (error) {
        for (const file of written.reverse()) {
            const original = originals.get(file);
            if (original === undefined) { await io.unlink(file); }
            else { await atomicWrite(file, original); }
        }
        throw error;
    }
}
