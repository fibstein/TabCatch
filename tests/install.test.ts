import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, installDep, readInstalledDb } from '../app/electron/deps/install';
import { checkDep, checkUpdates } from '../app/electron/deps/check';
import type { DepDef } from '../app/electron/deps/manifest';

const files = new Map<string, Buffer>();
let server: Server;
let base = '';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = files.get(req.url ?? '');
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => server.close());

const script = Buffer.from('#!/bin/sh\necho "tool 1.2.3"\n');

function def(over: Partial<DepDef> = {}): DepDef {
  return {
    id: 'yt-dlp', label: 'tool', reason: '', assetName: 'tool', assetUrl: `${base}/tool`, checksumUrl: `${base}/SUMS`,
    archive: 'none', files: ['tool'], versionFile: 'tool', versionArgs: [], autoUpdate: true, ...over,
  };
}
const opts = (binDir: string) => ({ binDir, fetch: (u: string) => fetch(u), retries: 2, backoffMs: 1 });

describe.skipIf(process.platform === 'win32')('installDep', () => {
  it('installs a verified binary, records it and detects updates', async () => {
    files.set('/tool', script);
    files.set('/SUMS', Buffer.from(`${sha(script)}  tool\n${'0'.repeat(64)}  other\n`));
    const bin = mkdtempSync(join(tmpdir(), 'tc-bin-'));
    await installDep(def(), opts(bin));
    expect(await checkDep(def(), bin)).toMatchObject({ state: 'ok', version: 'tool 1.2.3' });
    expect((await readInstalledDb(bin))['yt-dlp']?.sha256).toBe(sha(script));
    expect(await checkUpdates([def()], bin, (u) => fetch(u))).toEqual({ 'yt-dlp': false });

    const v2 = Buffer.from('#!/bin/sh\necho "tool 2"\n');
    files.set('/SUMS', Buffer.from(`${sha(v2)}  tool\n`));
    expect(await checkUpdates([def()], bin, (u) => fetch(u))).toEqual({ 'yt-dlp': true });
  });

  it('refuses a file whose checksum does not match and leaves nothing behind', async () => {
    files.set('/tool', script);
    files.set('/SUMS', Buffer.from(`${'a'.repeat(64)}  tool\n`));
    const bin = mkdtempSync(join(tmpdir(), 'tc-bin-'));
    await expect(installDep(def(), opts(bin))).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(readdirSync(bin)).toEqual([]);
    expect(await checkDep(def(), bin)).toMatchObject({ state: 'missing' });
  });

  it('extracts the needed executables from a nested zip', async () => {
    const work = mkdtempSync(join(tmpdir(), 'tc-zip-'));
    const zipPath = join(work, 'ff.zip');
    writeFileSync(join(work, 'ffmpeg'), script);
    execFileSync('python3', ['-I', '-c',
      'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor n in ("ffmpeg","ffprobe"): z.write(sys.argv[2], "ffmpeg-master/bin/"+n)\nz.write(sys.argv[2], "ffmpeg-master/doc/readme")\nz.close()',
      zipPath, join(work, 'ffmpeg')]);
    const zip = readFileSync(zipPath);
    files.set('/ff.zip', zip);
    files.set('/ff.sha', Buffer.from(`${sha(zip)}  ff.zip\n`));
    const bin = mkdtempSync(join(tmpdir(), 'tc-bin-'));
    const d = def({ id: 'ffmpeg', assetName: 'ff.zip', assetUrl: `${base}/ff.zip`, checksumUrl: `${base}/ff.sha`, archive: 'zip', files: ['ffmpeg', 'ffprobe'], versionFile: 'ffmpeg' });
    await installDep(d, opts(bin));
    expect(readdirSync(bin).sort()).toEqual(['ffmpeg', 'ffprobe', 'installed.json']);
    expect(await checkDep(d, bin)).toMatchObject({ state: 'ok' });
  });

  it('rejects archives with ../ entries and writes nothing', async () => {
    const work = mkdtempSync(join(tmpdir(), 'tc-evil-'));
    const zipPath = join(work, 'evil.zip');
    writeFileSync(join(work, 'payload'), script);
    execFileSync('python3', ['-I', '-c',
      'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.write(sys.argv[2], "../../../tool")\nz.write(sys.argv[2], "../../../../escaped")\nz.close()',
      zipPath, join(work, 'payload')]);
    const zip = readFileSync(zipPath);
    files.set('/evil.zip', zip);
    files.set('/evil.sha', Buffer.from(`${sha(zip)}  evil.zip\n`));
    const bin = mkdtempSync(join(tmpdir(), 'tc-bin-'));
    // yauzl refuses such archives outright; nothing may be installed or written outside.
    await expect(
      installDep(def({ assetName: 'evil.zip', assetUrl: `${base}/evil.zip`, checksumUrl: `${base}/evil.sha`, archive: 'zip' }), opts(bin)),
    ).rejects.toThrow(/invalid relative path/);
    expect(readdirSync(bin)).toEqual([]);
    expect(readdirSync(join(bin, '..')).includes('escaped')).toBe(false);
  });

  it('reports a broken binary', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'tc-bin-'));
    writeFileSync(join(bin, 'tool'), 'garbage', { mode: 0o755 });
    expect(await checkDep(def(), bin)).toMatchObject({ state: 'broken' });
  });
});
