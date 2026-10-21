import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { createHash, randomBytes } from 'crypto';
import { pipeline, Transform } from 'stream';
import { promisify } from 'util';
import { atomicWrite, exists, inside, io } from './files';
import { extractZip } from './archive';

export type Component = 'gradlerio' | 'allwpilib';
export interface Manifest {
    schemaVersion: 1 | 2;
    component: Component;
    version: string;
    wpilibVersion: string;
    archive: string;
    sha256: string;
    additionalArchives?: { archive: string; sha256: string }[];
    mavenPath: string;
}
export interface ReleaseAsset { name: string; browser_download_url: string; size?: number; }
export interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[]; }
export interface Candidate { repository: string; release: Release; manifest: Manifest; }
export interface Installed extends Candidate { directory: string; }
export interface Installation { gradlerio: Installed; allwpilib: Installed; }
const pipe = promisify(pipeline);
const headers = { 'User-Agent': 'VMX2026-VSCode', Accept: 'application/vnd.github+json' };
/** Release asset that describes a component (see RELEASES.md). */
export const manifestAssetName = 'vmx2026.json';

export function validateRepository(repository: string): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) { throw new Error('Use a GitHub repository in owner/repo format.'); }
    return repository;
}

export function validateManifest(input: unknown, component: Component): Manifest {
    const m = input as Manifest;
    if (!m || ![1, 2].includes(m.schemaVersion) || m.component !== component || typeof m.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(m.version) ||
        typeof m.wpilibVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(m.wpilibVersion) || typeof m.archive !== 'string' || !/^[^/\\]+\.zip$/.test(m.archive) || typeof m.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(m.sha256)) {
        throw new Error('Invalid ' + component + ' ' + manifestAssetName + ' release manifest (schema version 1 or 2 required).');
    }
    if (m.schemaVersion === 1 && m.additionalArchives !== undefined) { throw new Error('Multiple archives require schema version 2.'); }
    if (m.schemaVersion === 2) {
        if (!Array.isArray(m.additionalArchives) || !m.additionalArchives.length || m.additionalArchives.length > 15) { throw new Error('Invalid additional archives.'); }
        const names = new Set([m.archive.toLowerCase()]);
        for (const part of m.additionalArchives) {
            if (!part || typeof part.archive !== 'string' || !/^[^/\\]+\.zip$/.test(part.archive) || typeof part.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(part.sha256) || names.has(part.archive.toLowerCase())) { throw new Error('Invalid or duplicate additional archive.'); }
            names.add(part.archive.toLowerCase());
        }
    }
    inside('/bundle', m.mavenPath);
    return m;
}

function safeAssetUrl(url: string): string {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/releases\/download\//.test(parsed.pathname)) {
        throw new Error('Expected a GitHub release asset URL.');
    }
    return url;
}

async function json(url: string, asset = false): Promise<unknown> {
    const response = await fetch(asset ? safeAssetUrl(url) : url, { headers, timeout: 30000, size: 2 * 1024 * 1024 });
    if (!response.ok) {
        throw new Error('GitHub HTTP ' + response.status + ': ' + (response.status === 404 ? 'No published release found. Publish the prebuilt archives and ' + manifestAssetName + ' first.' : response.status === 403 ? 'API rate limit or repository access denied.' : response.statusText));
    }
    return response.json();
}

export async function findInstallation(repositories: { gradlerio: string; allwpilib: string }, prereleases: boolean,
    request: typeof json = json): Promise<{ gradlerio: Candidate; allwpilib: Candidate }> {
    async function releasesFor(component: Component): Promise<Release[]> {
        const repository = validateRepository(repositories[component]);
        const releases = await request('https://api.github.com/repos/' + repository + '/releases?per_page=30') as Release[];
        if (!Array.isArray(releases)) { throw new Error('Invalid GitHub releases response.'); }
        return releases.filter(r => !r.draft && (prereleases || !r.prerelease) && r.assets.some(a => a.name === manifestAssetName));
    }
    const cache = new Map<Release, Candidate>();
    async function candidate(component: Component, release: Release): Promise<Candidate> {
        const cached = cache.get(release);
        if (cached) { return cached; }
        const asset = release.assets.find(a => a.name === manifestAssetName)!;
        const manifest = validateManifest(await request(asset.browser_download_url, true), component);
        const result = { repository: repositories[component], release, manifest };
        cache.set(release, result);
        return result;
    }
    const [gradlerio, allwpilib] = await Promise.all([releasesFor('gradlerio'), releasesFor('allwpilib')]);
    for (const g of gradlerio) {
        const gradleCandidate = await candidate('gradlerio', g);
        for (const a of allwpilib) {
            const wpiCandidate = await candidate('allwpilib', a);
            if (gradleCandidate.manifest.wpilibVersion === wpiCandidate.manifest.wpilibVersion) {
                return { gradlerio: gradleCandidate, allwpilib: wpiCandidate };
            }
        }
    }
    throw new Error('No compatible prebuilt release pair found. Both repositories need ' + manifestAssetName + ' assets with the same wpilibVersion.');
}

export interface InstallProgress { component: Component; archive: string; transferred: number; total: number; cached?: boolean; }

export function candidateDownloadSize(candidate: Candidate): number {
    const names = new Set([candidate.manifest.archive, ...(candidate.manifest.additionalArchives || []).map(part => part.archive)]);
    return candidate.release.assets.reduce((sum, asset) => sum + (names.has(asset.name) ? (asset.size || 0) : 0), 0);
}

export async function installComponent(candidate: Candidate, storage: string, log: (message: string) => void,
    download: (url: string) => Promise<import('node-fetch').Response> = url => fetch(url, { headers, timeout: 120000 }),
    reportProgress?: (progress: InstallProgress) => void): Promise<Installed> {
    const { manifest, release } = candidate;
    const key = createHash('sha256').update(candidate.repository + '\n' + JSON.stringify(manifest)).digest('hex');
    const directory = path.join(storage, 'releases', key);
    const parts = [{ archive: manifest.archive, sha256: manifest.sha256 }, ...(manifest.additionalArchives || [])];
    const assets = parts.map(part => {
        const asset = release.assets.find(a => a.name === part.archive);
        if (!asset) { throw new Error('Release asset not found: ' + part.archive); }
        return { ...part, url: safeAssetUrl(asset.browser_download_url), size: asset.size };
    });
    const totalSize = assets.reduce((sum, asset) => sum + (asset.size || 0), 0);
    if (await exists(path.join(directory, '.complete'))) {
        if (reportProgress) { reportProgress({ component: manifest.component, archive: '', transferred: totalSize, total: totalSize, cached: true }); }
        return { ...candidate, directory };
    }
    await io.mkdir(path.dirname(directory), { recursive: true });
    const staging = directory + '.' + randomBytes(6).toString('hex');
    const archive = staging + '.zip';
    try {
        log('Downloading ' + candidate.repository + ' ' + release.tag_name);
        await io.mkdir(staging);
        let completedBytes = 0;
        for (const asset of assets) {
            log('Archive: ' + asset.archive);
            const response = await download(asset.url);
            if (!response.ok) { throw new Error('Download failed: HTTP ' + response.status); }
            const responseSize = Number(response.headers.get('content-length')) || 0;
            const partSize = asset.size || responseSize;
            const progressTotal = totalSize || partSize;
            if (reportProgress) { reportProgress({ component: manifest.component, archive: asset.archive, transferred: completedBytes, total: progressTotal }); }
            const hash = createHash('sha256');
            let currentBytes = 0;
            let lastProgress = 0;
            const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) {
                hash.update(chunk); currentBytes += chunk.length;
                const now = Date.now();
                if (reportProgress && (now - lastProgress >= 150 || (partSize > 0 && currentBytes >= partSize))) {
                    reportProgress({ component: manifest.component, archive: asset.archive, transferred: completedBytes + currentBytes, total: progressTotal });
                    lastProgress = now;
                }
                done(null, chunk);
            } });
            await pipe(response.body, hashing, fs.createWriteStream(archive, { flags: 'wx' }));
            if (hash.digest('hex') !== asset.sha256.toLowerCase()) { throw new Error('SHA-256 mismatch: ' + asset.archive); }
            completedBytes += currentBytes;
            if (reportProgress) { reportProgress({ component: manifest.component, archive: asset.archive, transferred: completedBytes, total: progressTotal }); }
            await extractZip(archive, staging);
            await io.unlink(archive);
        }
        const repository = inside(staging, manifest.mavenPath);
        if (!(await io.stat(repository)).isDirectory()) { throw new Error('Missing Maven repository in ' + manifest.archive); }
        if (manifest.component === 'gradlerio') {
            const marker = path.join(repository, 'edu/wpi/first/GradleRIO/edu.wpi.first.GradleRIO.gradle.plugin', manifest.version,
                'edu.wpi.first.GradleRIO.gradle.plugin-' + manifest.version + '.pom');
            if (!await exists(marker)) { throw new Error('GradleRIO archive is missing its plugin marker POM.'); }
            const implementation = path.join(repository, 'edu/wpi/first/GradleRIO', manifest.version, 'GradleRIO-' + manifest.version);
            if (!await exists(implementation + '.jar') || !await exists(implementation + '.pom')) {
                throw new Error('GradleRIO archive is missing its implementation JAR or POM.');
            }
        } else {
            // The allwpilib component is the VMX HAL repository: hal-cpp and hal-java at manifest.version.
            for (const artifact of ['hal-cpp', 'hal-java']) {
                const pom = path.join(repository, 'edu/wpi/first/hal', artifact, manifest.version, artifact + '-' + manifest.version + '.pom');
                if (!await exists(pom)) { throw new Error('VMX HAL archive is missing ' + artifact + ' ' + manifest.version + '.'); }
            }
            const vmxHal = path.join(repository, 'edu/wpi/first/hal/hal-cpp', manifest.version, 'hal-cpp-' + manifest.version + '-linuxarm64.zip');
            if (!await exists(vmxHal)) { throw new Error('VMX HAL archive is missing the linuxarm64 HAL.'); }
        }
        await atomicWrite(path.join(staging, '.complete'), JSON.stringify(candidate));
        await io.rename(staging, directory);
        log('Installed ' + manifest.component + ' ' + manifest.version);
        return { ...candidate, directory };
    } finally {
        await io.unlink(archive).catch(() => undefined);
        await io.rm(staging, { recursive: true }).catch(() => undefined);
    }
}
