import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectGaps, durationMatches, evaluateProbe, repairFile, verifyFile } from '../app/electron/verify';

describe('evaluateProbe', () => {
  const probe = (duration: string, types = ['video', 'audio']) => ({
    streams: types.map((t) => ({ codec_type: t, codec_name: t === 'video' ? 'h264' : 'aac' })),
    format: { duration },
  });
  it('accepts matching files', () => {
    expect(evaluateProbe(probe('600.4'), { duration: 600, expectVideo: true, expectAudio: true })).toMatchObject({ ok: true, videoCodec: 'h264' });
  });
  it('flags short files and missing streams', () => {
    const r = evaluateProbe(probe('300', ['video']), { duration: 600, expectVideo: true, expectAudio: true });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Ses stream yok.*Süre uyuşmuyor/);
  });
  it('ignores cover art as a video stream', () => {
    const r = evaluateProbe({ streams: [{ codec_type: 'video', codec_name: 'mjpeg' }, { codec_type: 'audio' }], format: { duration: '10' } }, { duration: 10, expectVideo: true, expectAudio: true });
    expect(r.problems).toEqual(['Video stream yok']);
  });
  it('tolerance is 2 s, or 0.5 % for long videos', () => {
    expect(durationMatches(11.9, 10)).toBe(true);
    expect(durationMatches(12.5, 10)).toBe(false);
    // One lost 6 s fragment in a 10 min video must be caught.
    expect(durationMatches(594, 600)).toBe(false);
    expect(durationMatches(3585, 3600)).toBe(true);
    expect(durationMatches(3570, 3600)).toBe(false);
  });
});

describe('detectGaps', () => {
  it('finds holes and backwards jumps in packet timestamps', () => {
    const frames = (from: number, to: number) => Array.from({ length: Math.round((to - from) * 25) }, (_, i) => from + i / 25);
    expect(detectGaps(frames(0, 30))).toEqual([]);
    const holed = [...frames(0, 12), ...frames(16, 30)];
    expect(detectGaps(holed)).toHaveLength(1);
    expect(detectGaps(holed)[0].to).toBeCloseTo(16);
    expect(detectGaps([0, 1, 2, 0.5, 1.5])).toHaveLength(1);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version']);
    execFileSync('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('with real ffmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabcatch-verify-'));
  const good = join(dir, 'good.mp4');
  const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const exp = { duration: 20, expectVideo: true, expectAudio: true };

  beforeAll(() => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', good]);
  });

  it('accepts a complete file', async () => {
    expect(await verifyFile('ffprobe', good, exp)).toMatchObject({ ok: true, videoCodec: 'h264', audioCodec: 'aac' });
  });

  it('detects a truncated download', async () => {
    const cut = join(dir, 'cut.ts');
    // MPEG-TS keeps playing when cut, like a download whose last fragments were lost.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', good, '-c', 'copy', cut]);
    truncateSync(cut, Math.floor(statSync(cut).size / 2));
    const r = await verifyFile('ffprobe', cut, exp);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Süre uyuşmuyor/);
  });

  it('detects a missing fragment that keeps the full duration (yt-dlp default behaviour)', async () => {
    // Same as what a skipped HLS fragment produces: 0-12 s and 16-20 s, timestamps preserved.
    const holed = join(dir, 'holed.ts');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', good, '-c', 'copy', '-bsf:v', 'noise=drop=between(pts*tb\\,12\\,16)', '-bsf:a', 'noise=drop=between(pts*tb\\,12\\,16)', holed]);
    const r = await verifyFile('ffprobe', holed, exp);
    expect(r.actualDuration).toBeGreaterThan(19);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Görüntü akışında 1 boşluk.*0:1[12] → 0:1[56].*Ses akışında 1 boşluk/);
  });

  it('remux repair turns a raw TS stream into a faststart MP4 and keeps the original', async () => {
    const ts = join(dir, 'raw.ts');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', good, '-c', 'copy', ts]);
    const { path, verify } = await repairFile(bins, ts, 'remux', exp);
    expect(verify.ok).toBe(true);
    expect(path).toBe(join(dir, 'raw.mp4'));
    expect(existsSync(`${ts}.orig`)).toBe(true);
  });

  it('reencode repair produces h264 + aac', async () => {
    const src = join(dir, 'vp9.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', good, '-t', '5', '-c:v', 'mpeg4', '-c:a', 'mp3', src]);
    const { verify } = await repairFile(bins, src, 'reencode', { ...exp, duration: 5 });
    expect(verify).toMatchObject({ ok: true, videoCodec: 'h264', audioCodec: 'aac' });
  });
});
