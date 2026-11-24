import { describe, expect, it } from 'vitest';
import { isCandidateUrl, parseExtMessage } from '../shared/protocol';
import { parseChecksum } from '../app/electron/deps/manifest';

describe('isCandidateUrl', () => {
  it('keeps web pages and drops browser-internal pages', () => {
    expect(isCandidateUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isCandidateUrl('http://example.com/video.mp4')).toBe(true);
    for (const u of ['chrome://extensions', 'edge://settings', 'opera://startpage', 'about:blank', 'chrome-extension://x/y', 'file:///C:/a.mp4', 'not a url']) {
      expect(isCandidateUrl(u)).toBe(false);
    }
  });
});

describe('parseExtMessage', () => {
  it('parses tabs and drops malformed entries', () => {
    const m = parseExtMessage(JSON.stringify({ type: 'tabs', requestId: 'r', browser: 'edge', tabs: [{ tabId: 1, windowId: 2, url: 'https://a', title: 'A' }, { nope: 1 }] }));
    expect(m).toEqual({ type: 'tabs', requestId: 'r', browser: 'edge', tabs: [{ tabId: 1, windowId: 2, url: 'https://a', title: 'A', favIconUrl: undefined }] });
  });
  it('rejects garbage', () => {
    expect(parseExtMessage('{')).toBeNull();
    expect(parseExtMessage('{"type":"evil"}')).toBeNull();
    expect(parseExtMessage(JSON.stringify({ type: 'hello', browser: 'netscape' }))).toMatchObject({ browser: 'unknown' });
  });
});

describe('parseChecksum', () => {
  const sums = [
    '622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c  yt-dlp.exe',
    '9bb324203d02970b70dab6c9f6a48bd5ff185db7859d562cdacd1dc655ccb72a  yt-dlp_arm64.exe',
  ].join('\n');
  it('picks the line for the asset from a SUMS file', () => {
    expect(parseChecksum(sums, 'yt-dlp.exe')).toBe('622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c');
    expect(parseChecksum(sums, 'missing.exe')).toBeNull();
  });
  it('reads PowerShell Get-FileHash output (Deno)', () => {
    const ps = '\nAlgorithm : SHA256\nHash      : CBA84B26E0DF5AE7F74FC66B86A95B866872A86292EBD84FA1E959927EDD93BF\nPath      : C:\\a\\deno.zip\n';
    expect(parseChecksum(ps, 'deno-x86_64-pc-windows-msvc.zip')).toBe('cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf');
  });
});
