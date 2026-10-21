import * as fs from 'fs';
import * as path from 'path';
import { createInflateRaw } from 'zlib';
import { pipeline, Transform } from 'stream';
import { promisify } from 'util';
import { inside, io } from './files';

const pipe = promisify(pipeline);

// ZIP32, stored/deflate only. Stream large artifacts instead of buffering the SDK.
// Reject symlinks, duplicate paths, encryption and ZIP64 rather than extracting ambiguously.
export async function extractZip(archive: string, destination: string): Promise<void> {
    const file = await io.open(archive, 'r');
    async function read(offset: number, length: number): Promise<Buffer> {
        const buffer = Buffer.alloc(length);
        const result = await file.read(buffer, 0, length, offset);
        if (result.bytesRead !== length) { throw new Error('Truncated ZIP archive'); }
        return buffer;
    }
    try {
        const size = (await file.stat()).size;
        const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
        let end = tail.length - 22;
        while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) { end--; }
        if (end < 0) { throw new Error('Missing ZIP directory'); }
        const count = tail.readUInt16LE(end + 10);
        const directorySize = tail.readUInt32LE(end + 12);
        const directoryStart = tail.readUInt32LE(end + 16);
        if (tail.readUInt32LE(end + 4) !== 0 || count !== tail.readUInt16LE(end + 8) || count === 65535 || directorySize > 32 * 1024 * 1024 || directoryStart + directorySize > size) {
            throw new Error('Unsupported multi-disk, ZIP64 or oversized ZIP directory');
        }
        const directory = await read(directoryStart, directorySize);
        const seen = new Set<string>();
        let offset = 0;
        let total = 0;
        for (let entry = 0; entry < count; entry++) {
            if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) { throw new Error('Invalid ZIP entry'); }
            const flags = directory.readUInt16LE(offset + 8);
            const method = directory.readUInt16LE(offset + 10);
            const compressed = directory.readUInt32LE(offset + 20);
            const expanded = directory.readUInt32LE(offset + 24);
            const nameLength = directory.readUInt16LE(offset + 28);
            const extraLength = directory.readUInt16LE(offset + 30);
            const commentLength = directory.readUInt16LE(offset + 32);
            const attributes = directory.readUInt32LE(offset + 38);
            const local = directory.readUInt32LE(offset + 42);
            if (offset + 46 + nameLength + extraLength + commentLength > directory.length) { throw new Error('Truncated ZIP entry'); }
            const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
            offset += 46 + nameLength + extraLength + commentLength;
            const output = inside(destination, name.replace(/\/$/, ''));
            const key = output.toLowerCase(); // Also safe on Windows/macOS case-insensitive filesystems.
            total += expanded;
            if (seen.has(key) || flags & 1 || ![0, 8].includes(method) || ((attributes >>> 16) & 0xf000) === 0xa000 || compressed === 0xffffffff || total > 8 * 1024 * 1024 * 1024) {
                throw new Error('Unsafe or unsupported ZIP entry: ' + name);
            }
            seen.add(key);
            if (name.endsWith('/')) { await io.mkdir(output, { recursive: true }); continue; }
            const header = await read(local, 30);
            if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== method) { throw new Error('Invalid ZIP local header'); }
            const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
            if (start + compressed > directoryStart) { throw new Error('ZIP entry overlaps its directory'); }
            await io.mkdir(path.dirname(output), { recursive: true });
            let actual = 0;
            const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
                actual += chunk.length;
                done(actual > expanded ? new Error('ZIP expansion exceeds declared size') : null, chunk);
            } });
            if (compressed === 0) { await io.writeFile(output, Buffer.alloc(0), { flag: 'wx' }); }
            else {
                const source = fs.createReadStream(archive, { start, end: start + compressed - 1 });
                if (method === 8) { await pipe(source, createInflateRaw(), limit, fs.createWriteStream(output, { flags: 'wx' })); }
                else { await pipe(source, limit, fs.createWriteStream(output, { flags: 'wx' })); }
            }
            if (actual !== expanded) { throw new Error('ZIP entry size mismatch: ' + name); }
        }
    } finally { await file.close(); }
}
