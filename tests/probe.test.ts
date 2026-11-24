import { describe, expect, it } from 'vitest';
import { buildProbeArgs, parseProbeOutput, ProbeService, urlNamesPlaylist } from '../app/electron/probe';
import type { RunHandle } from '../app/electron/downloader';

describe('parseProbeOutput', () => {
  it('reads a single video with merged formats', () => {
    const j = {
      _type: 'video', extractor_key: 'Youtube', id: 'abc', title: 'T', duration: 615.5, height: 1080,
      requested_formats: [{ filesize: 100 }, { filesize_approx: 20 }], formats: [{ height: 360 }, { height: 1080 }],
    };
    expect(parseProbeOutput('https://youtu.be/abc', ['[debug] x', JSON.stringify(j)], 0)).toMatchObject({
      supported: true, isPlaylist: false, extractor: 'Youtube', id: 'abc', title: 'T', duration: 615.5, filesize: 120, maxHeight: 1080, hasPlaylist: false,
    });
  });
  it('reads flat playlist entries and drops non-http ones', () => {
    const j = { _type: 'playlist', extractor_key: 'YoutubeTab', id: 'PL1', title: 'Liste', playlist_count: 3,
      entries: [{ url: 'https://www.youtube.com/watch?v=1', title: 'Bir', id: '1', duration: 60 }, { url: 'xyz', title: 'bad' }, { webpage_url: 'https://www.youtube.com/watch?v=2', title: 'İki' }] };
    const r = parseProbeOutput('https://www.youtube.com/playlist?list=PL1', [JSON.stringify(j)], 0);
    expect(r).toMatchObject({ isPlaylist: true, entryCount: 3, hasPlaylist: true });
    expect(r.entries?.map((e) => e.title)).toEqual(['Bir', 'İki']);
  });
  it('uses the entry URL, not the parent page, for generic multi-video pages', () => {
    const page = 'http://site/two.html';
    const j = { _type: 'playlist', extractor_key: 'Generic', entries: [
      { url: 'http://site/a.mp4', webpage_url: page, title: 'a' }, { url: 'http://site/b.mp4', webpage_url: page, title: 'b' }, { url: 'http://site/a.mp4', webpage_url: page } ] };
    expect(parseProbeOutput(page, [JSON.stringify(j)], 0).entries?.map((e) => e.url)).toEqual(['http://site/a.mp4', 'http://site/b.mp4']);
  });
  it('turns "Unsupported URL" into a readable message', () => {
    const r = parseProbeOutput('https://mail.example.com/', ['ERROR: Unsupported URL: https://mail.example.com/'], 1);
    expect(r).toMatchObject({ supported: false, error: 'Bu sayfada yt-dlp video bulamadı' });
  });
  it('detects playlist-looking URLs', () => {
    expect(urlNamesPlaylist('https://www.youtube.com/watch?v=1&list=PL1')).toBe(true);
    expect(urlNamesPlaylist('https://www.youtube.com/playlist?list=PL1')).toBe(true);
    expect(urlNamesPlaylist('https://www.youtube.com/watch?v=1')).toBe(false);
  });
  it('builds args with the download preset and a playlist cap', () => {
    const v = buildProbeArgs({ url: 'u', preset: 'compat', denoPath: '/d', playlist: false });
    expect(v).toContain('--no-playlist');
    expect(v.join(' ')).toContain('-S vcodec:h264,res,acodec:m4a');
    const p = buildProbeArgs({ url: 'u', preset: 'compat', denoPath: '/d', playlist: true, cookiesFile: '/c.txt' });
    expect(p.join(' ')).toContain('--yes-playlist -I :500');
    expect(p.join(' ')).toContain('--cookies /c.txt');
  });
});

describe('ProbeService', () => {
  function fake() {
    const runs: { args: string[]; finish: (out: object | null) => void }[] = [];
    const cleaned: string[] = [];
    const svc = new ProbeService({
      concurrency: 2,
      run: (args): RunHandle => {
        let cb: (l: string) => void = () => {};
        let resolve!: (c: number) => void;
        const done = new Promise<number>((r) => (resolve = r));
        runs.push({ args, finish: (out) => { if (out) cb(JSON.stringify(out)); else cb('ERROR: boom'); resolve(out ? 0 : 1); } });
        return { onLine: (c) => (cb = c), done, kill: () => resolve(1) };
      },
      prepare: async (url) => ({ args: [url], cleanup: async () => void cleaned.push(url) }),
    });
    return { svc, runs, cleaned };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('runs at most two checks at a time, dedupes and caches successes', async () => {
    const { svc, runs, cleaned } = fake();
    const p = ['a', 'b', 'c'].map((u) => svc.probe(u));
    const dup = svc.probe('a');
    await tick();
    expect(runs.map((r) => r.args[0])).toEqual(['a', 'b']);
    expect(svc.activeCount()).toBe(2);
    runs[0].finish({ id: 'a', title: 'A' });
    await tick();
    await tick();
    expect(runs.map((r) => r.args[0])).toEqual(['a', 'b', 'c']);
    runs[1].finish(null);
    runs[2].finish({ id: 'c' });
    const [a, b] = await Promise.all(p);
    expect(await dup).toBe(a);
    expect(b.supported).toBe(false);
    expect(cleaned.sort()).toEqual(['a', 'b', 'c']);
    // success cached, failure retried
    await svc.probe('a');
    void svc.probe('b');
    await tick();
    expect(runs).toHaveLength(4);
  });

  it('refuses to start yt-dlp while dependencies are being replaced', async () => {
    const { svc, runs } = fake();
    svc.setBlocked(true);
    const r = await svc.probe('x');
    expect(r.supported).toBe(false);
    expect(runs).toHaveLength(0);
  });
});
