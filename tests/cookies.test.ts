import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isYouTubeUrl, toNetscapeCookies, type CookieInfo } from '../shared/protocol';
import { cookieDecision, pickCookieClient, writeCookieFile } from '../app/electron/cookies';
import type { BridgeClient } from '../app/electron/bridge';

const c = (over: Partial<CookieInfo>): CookieInfo => ({
  domain: '.site.com', hostOnly: false, path: '/', secure: true, httpOnly: false, expirationDate: 1900000000.5, name: 'n', value: 'v', ...over,
});

describe('toNetscapeCookies', () => {
  it('writes domain, host-only, HttpOnly and session cookies the way yt-dlp reads them', () => {
    const txt = toNetscapeCookies([
      c({ name: 'sid', value: 'abc' }),
      c({ domain: 'www.site.com', hostOnly: true, name: 'h', secure: false }),
      c({ name: 'auth', httpOnly: true }),
      c({ name: 'sess', expirationDate: undefined }),
    ]);
    const rows = txt.split('\n').filter((l) => l && !l.startsWith('# '));
    expect(rows).toEqual([
      '.site.com\tTRUE\t/\tTRUE\t1900000000\tsid\tabc',
      'www.site.com\tFALSE\t/\tFALSE\t1900000000\th\tv',
      '#HttpOnly_.site.com\tTRUE\t/\tTRUE\t1900000000\tauth\tv',
      '.site.com\tTRUE\t/\tTRUE\t0\tsess\tv',
    ]);
    expect(txt.startsWith('# Netscape HTTP Cookie File\n')).toBe(true);
  });
  it('drops cookies that would break the tab-separated format', () => {
    expect(toNetscapeCookies([c({ value: 'a\tb' }), c({ name: 'x\ny' })]).split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([]);
  });
});

describe('cookie policy', () => {
  it('recognises YouTube hosts only', () => {
    for (const u of ['https://www.youtube.com/watch?v=1', 'https://youtu.be/1', 'https://music.youtube.com/x', 'https://m.youtube.com/x']) expect(isYouTubeUrl(u)).toBe(true);
    for (const u of ['https://notyoutube.com/x', 'https://youtube.com.evil.net/x', 'https://vimeo.com/1']) expect(isYouTubeUrl(u)).toBe(false);
  });
  it('YouTube needs its own opt-in', () => {
    const on = { sendCookies: true, sendYouTubeCookies: false };
    expect(cookieDecision('https://vimeo.com/1', on)).toEqual({ send: true });
    expect(cookieDecision('https://www.youtube.com/watch?v=1', on)).toMatchObject({ send: false, note: expect.stringContaining('YouTube') });
    expect(cookieDecision('https://www.youtube.com/watch?v=1', { ...on, sendYouTubeCookies: true })).toEqual({ send: true });
    expect(cookieDecision('https://vimeo.com/1', { sendCookies: false, sendYouTubeCookies: true })).toEqual({ send: false });
  });
  it('falls back to another connection of the same browser after a reconnect', () => {
    const clients: BridgeClient[] = [
      { id: 'e1', browser: 'edge', extensionVersion: '0.2.0', canReadCookies: true },
      { id: 'o2', browser: 'opera', extensionVersion: '0.1.0', canReadCookies: false },
      { id: 'o3', browser: 'opera', extensionVersion: '0.2.0', canReadCookies: true },
    ];
    expect(pickCookieClient(clients, { clientId: 'e1', browser: 'edge' })?.id).toBe('e1');
    expect(pickCookieClient(clients, { clientId: 'gone', browser: 'opera' })?.id).toBe('o3');
    expect(pickCookieClient(clients, { clientId: 'gone', browser: 'chrome' })).toBeUndefined();
  });
  it('writes the cookie file readable only by the user', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-ck-'));
    const f = await writeCookieFile(join(dir, 'sub'), 'item1', [c({})]);
    expect(readFileSync(f, 'utf8')).toContain('\tn\tv');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
