import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { parseChecksum, type DepDef, type DepId } from './manifest';

const execFileP = promisify(execFile);

export type FetchLike = (url: string) => Promise<Response>;

export interface InstallProgress {
  depId: DepId;
  phase: 'checksum' | 'download' | 'extract' | 'done';
  received: number;
  total: number | null;
  attempt: number;
}

export interface InstalledRecord {
  sha256: string;
  assetName: string;
  installedAt: string;
}

export type InstalledDb = Partial<Record<DepId, InstalledRecord>>;

export interface InstallOptions {
  binDir: string;
  fetch: FetchLike;
  onProgress?: (p: InstallProgress) => void;
  retries?: number;
  backoffMs?: number;
}

export class ChecksumMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`SHA-256 uyuşmuyor: beklenen ${expected}, gelen ${actual}`);
  }
}

const DB_FILE = 'installed.json';

export async function readInstalledDb(binDir: string): Promise<InstalledDb> {
  try {
    return JSON.parse(await readFile(join(binDir, DB_FILE), 'utf8')) as InstalledDb;
  } catch {
    return {};
  }
}

async function writeInstalledDb(binDir: string, db: InstalledDb) {
  const tmp = join(binDir, `${DB_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, join(binDir, DB_FILE));
}

export async function fetchExpectedChecksum(def: DepDef, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(def.checksumUrl);
  if (!res.ok) throw new Error(`Checksum dosyası alınamadı (${res.status}): ${def.checksumUrl}`);
  const hash = parseChecksum(await res.text(), def.assetName);
  if (!hash) throw new Error(`Checksum dosyasında ${def.assetName} bulunamadı`);
  return hash;
}

/** Streams the asset to `<dest>.part` while hashing it; the file is only renamed once the hash matches. */
async function downloadVerified(
  url: string,
  dest: string,
  expected: string,
  fetchImpl: FetchLike,
  onChunk: (received: number, total: number | null) => void,
): Promise<void> {
  const part = `${dest}.part`;
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`İndirme başarısız (${res.status}): ${url}`);
  const totalHeader = Number(res.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const hash = createHash('sha256');
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const src = Readable.fromWeb(res.body as unknown as WebReadableStream);
      const out = createWriteStream(part);
      src.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        onChunk(received, total);
      });
      src.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      src.pipe(out);
    });
    const actual = hash.digest('hex');
    if (actual !== expected) throw new ChecksumMismatchError(expected, actual);
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

/**
 * Extracts only the named executables, wherever they sit in the archive, to paths we choose.
 * Entry paths are never used as output paths, so symlink / `../` entries cannot escape `outDir`.
 */
function extractNamedFromZip(zipPath: string, names: string[], outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip açılamadı'));
      const pending = new Set(names);
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.split('/').pop() ?? '';
        if (entry.fileName.endsWith('/') || !pending.has(name)) return zip.readEntry();
        pending.delete(name);
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error(`${name} okunamadı`));
          const out = createWriteStream(join(outDir, name));
          stream.on('error', reject);
          out.on('error', reject);
          out.on('finish', () => zip.readEntry());
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

async function findFiles(dir: string, names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name) && !found.has(e.name)) {
      found.set(e.name, join(e.parentPath, e.name));
    }
  }
  return found;
}

async function installOnce(def: DepDef, opts: InstallOptions, attempt: number): Promise<InstalledRecord> {
  const report = (phase: InstallProgress['phase'], received = 0, total: number | null = null) =>
    opts.onProgress?.({ depId: def.id, phase, received, total, attempt });

  report('checksum');
  const expected = await fetchExpectedChecksum(def, opts.fetch);
  await mkdir(opts.binDir, { recursive: true });
  const work = await mkdtemp(join(opts.binDir, `.tmp-${def.id}-`));
  try {
    const assetPath = join(work, def.assetName);
    await downloadVerified(def.assetUrl, assetPath, expected, opts.fetch, (r, t) => report('download', r, t));

    let sources: Map<string, string>;
    if (def.archive === 'none') {
      sources = new Map([[def.files[0], assetPath]]);
    } else {
      report('extract');
      const outDir = join(work, 'x');
      await mkdir(outDir);
      if (def.archive === 'zip') await extractNamedFromZip(assetPath, def.files, outDir);
      else await execFileP('tar', ['-xJf', assetPath, '-C', outDir]);
      sources = await findFiles(outDir, def.files);
    }
    const missing = def.files.filter((f) => !sources.has(f));
    if (missing.length) throw new Error(`Arşivde bulunamadı: ${missing.join(', ')}`);

    // Copy next to the target first, then rename: the old binary stays usable until the very end.
    for (const name of def.files) {
      const target = join(opts.binDir, name);
      const staged = `${target}.new`;
      await copyFile(sources.get(name)!, staged);
      if (process.platform !== 'win32') await chmod(staged, 0o755);
      await rename(staged, target);
    }
    const record: InstalledRecord = { sha256: expected, assetName: def.assetName, installedAt: new Date().toISOString() };
    const db = await readInstalledDb(opts.binDir);
    db[def.id] = record;
    await writeInstalledDb(opts.binDir, db);
    report('done');
    return record;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function installDep(def: DepDef, opts: InstallOptions): Promise<InstalledRecord> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 1500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await installOnce(def, opts, attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

