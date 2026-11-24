import { describe, expect, it } from 'vitest';
import { addCandidate, classifyMedia, rankCandidates, safeTitle, totalSize, type MediaCandidate } from '../shared/media';
import { buildYtDlpArgs } from '../app/electron/ytdlp';
import { parseExtMessage } from '../shared/protocol';

const h = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

describe('classifyMedia', () => {
  it('finds HLS/DASH manifests by extension or content type', () => {
    expect(classifyMedia('https://cdn.x.com/v/master.m3u8?token=1', 200)).toMatchObject({ kind: 'hls' });
    expect(classifyMedia('https://cdn.x.com/play?id=5', 200, h({ 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }))).toMatchObject({ kind: 'hls' });
    expect(classifyMedia('https://cdn.x.com/v/manifest.mpd', 200)).toMatchObject({ kind: 'dash' });
  });
  it('keeps big progressive files, including Range responses', () => {
    expect(classifyMedia('https://x.com/movie.mp4', 206, h({ 'content-range': 'bytes 0-1023/52428800' }))).toMatchObject({ kind: 'file', size: 52428800 });
    expect(classifyMedia('https://x.com/stream?id=1', 200, h({ 'content-type': 'video/webm', 'content-length': '9000000' }))).toMatchObject({ kind: 'file' });
  });
  it('ignores segments, tiny clips, errors and sites yt-dlp handles itself', () => {
    expect(classifyMedia('https://cdn.x.com/v/seg-12.ts', 200)).toBeNull();
    expect(classifyMedia('https://cdn.x.com/v/chunk_33.mp4', 200, h({ 'content-type': 'video/mp4' }))).toBeNull();
    expect(classifyMedia('https://cdn.x.com/v/123.m4s', 200)).toBeNull();
    expect(classifyMedia('https://cdn.x.com/v/a.ts', 200, h({ 'content-type': 'video/mp2t' }))).toBeNull();
    expect(classifyMedia('https://x.com/hover-preview.mp4', 200, h({ 'content-length': '50000' }))).toBeNull();
    expect(classifyMedia('https://x.com/movie.mp4', 403)).toBeNull();
    expect(classifyMedia('https://rr1---sn-x.googlevideo.com/videoplayback?itag=22', 200, h({ 'content-type': 'video/mp4' }))).toBeNull();
    expect(classifyMedia('https://x.com/page.html', 200, h({ 'content-type': 'text/html' }))).toBeNull();
  });
  it('reads total size from Content-Range or Content-Length', () => {
    expect(totalSize(206, h({ 'Content-Range': 'bytes 100-200/999' }))).toBe(999);
    expect(totalSize(200, h({ 'Content-Length': '42' }))).toBe(42);
    expect(totalSize(206, h({ 'Content-Length': '42' }))).toBeUndefined(); // partial length is not the file size
  });
});

describe('candidate list', () => {
  const c = (url: string, kind: MediaCandidate['kind'], seenAt: number, size?: number): MediaCandidate => ({ url, kind, seenAt, size });
  it('dedupes, caps and ranks manifests (first seen) before big files', () => {
    let list: MediaCandidate[] = [];
    for (let i = 0; i < 25; i++) list = addCandidate(list, c(`https://x/${i}.mp4`, 'file', i, i * 1e6));
    list = addCandidate(list, c('https://x/3.mp4', 'file', 99, 3e6));
    expect(list).toHaveLength(20);
    // 3.mp4 fell off the cap earlier; seen again it comes back exactly once, at the top.
    expect(list.filter((x) => x.url === 'https://x/3.mp4')).toHaveLength(1);
    expect(list[0].url).toBe('https://x/3.mp4');
    const ranked = rankCandidates([c('https://x/small.mp4', 'file', 1, 1e6), c('https://x/chunklist.m3u8', 'hls', 5), c('https://x/master.m3u8', 'hls', 2), c('https://x/big.mp4', 'file', 3, 9e6)]);
    expect(ranked.map((x) => x.url.split('/').pop())).toEqual(['master.m3u8', 'chunklist.m3u8', 'big.mp4', 'small.mp4']);
  });
});

describe('safeTitle', () => {
  it('makes tab titles safe for Windows file names and yt-dlp templates', () => {
    expect(safeTitle('Ders 1: Giriş / Kurulum? <100%> "final"...')).toBe('Ders 1_ Giriş _ Kurulum_ _100%%_ _final_');
    expect(safeTitle('   ')).toBe('video');
    expect([...safeTitle('ş'.repeat(300))]).toHaveLength(150);
  });
});

describe('captured stream download args', () => {
  it('sends Referer/Origin of the page and names the file after the page title', () => {
    const a = buildYtDlpArgs({ url: 'https://cdn.x.com/master.m3u8', outputDir: '/o', preset: 'compat', ffmpegDir: '/b', denoPath: '/b/deno', page: { url: 'https://site.com/watch/5', title: 'Film: 5%' } });
    const s = a.join(' ');
    expect(s).toContain('--add-headers Referer:https://site.com/watch/5 --add-headers Origin:https://site.com');
    expect(a[a.indexOf('-o') + 1]).toBe('Film_ 5%% [%(id)s].%(ext)s');
    expect(a.slice(-2)).toEqual(['--', 'https://cdn.x.com/master.m3u8']);
  });
});

describe('tabs message with media', () => {
  it('keeps valid candidates only', () => {
    const m = parseExtMessage(JSON.stringify({ type: 'tabs', requestId: 'r', browser: 'edge', tabs: [{ tabId: 1, windowId: 1, url: 'https://a', title: 'A',
      media: [{ url: 'https://cdn/m.m3u8', kind: 'hls', seenAt: 1 }, { url: 'javascript:x', kind: 'hls' }, { url: 'https://cdn/x', kind: 'evil' }] }] }));
    expect(m && m.type === 'tabs' && m.tabs[0].media).toEqual([{ url: 'https://cdn/m.m3u8', kind: 'hls', seenAt: 1, contentType: undefined, size: undefined }]);
  });
});
