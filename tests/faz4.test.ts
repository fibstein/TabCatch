import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildYtDlpArgs, formatTime, outputTemplate, parseSection, parseTime, sectionTag } from '../app/electron/ytdlp';
import { historyKey } from '../app/electron/history';
import { evaluateProbe, verifyFile } from '../app/electron/verify';

const base = { url: 'https://v/1', outputDir: '/o', ffmpegDir: '/b', denoPath: '/b/deno' };
const allOn = { metadata: true, thumbnail: true, chapters: true, subtitles: true, subLangs: 'tr,en.*', autoSubtitles: false };

describe('time ranges', () => {
  it('parses and formats', () => {
    expect(parseTime('75')).toBe(75);
    expect(parseTime('10:05')).toBe(605);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('1:x')).toBeNull();
    expect(parseSection('10:00-15:30')).toEqual({ start: 600, end: 930 });
    expect(parseSection(' 1:00:00 – 1:10:00 ')).toEqual({ start: 3600, end: 4200 });
    expect(parseSection('15:00-10:00')).toBeNull();
    expect(parseSection('abc')).toBeNull();
    expect(formatTime(930)).toBe('15:30');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(sectionTag({ start: 600, end: 930 })).toBe('[10m00s-15m30s]');
  });
});

describe('yt-dlp args for Faz 4 options', () => {
  it('embeds metadata, chapters, a JPEG cover and subtitles', () => {
    const a = buildYtDlpArgs({ ...base, preset: 'compat', embed: allOn }).join(' ');
    expect(a).toContain('--embed-metadata');
    expect(a).not.toContain('chapters'); // included in --embed-metadata
    expect(a).toContain('--embed-thumbnail --convert-thumbnails jpg');
    expect(a).toContain('--write-subs --sub-langs tr,en.* --embed-subs --sleep-subtitles 2');
    expect(a).not.toContain('--write-auto-subs');
  });
  it('handles the chapter / metadata combinations', () => {
    expect(buildYtDlpArgs({ ...base, preset: 'compat', embed: { ...allOn, chapters: false } })).toContain('--no-embed-chapters');
    const onlyChapters = buildYtDlpArgs({ ...base, preset: 'compat', embed: { ...allOn, metadata: false } });
    expect(onlyChapters).toContain('--embed-chapters');
    expect(onlyChapters).not.toContain('--embed-metadata');
  });
  it('skips subtitles for audio and when turned off', () => {
    expect(buildYtDlpArgs({ ...base, preset: 'audio', embed: allOn }).join(' ')).not.toContain('subs');
    expect(buildYtDlpArgs({ ...base, preset: 'compat', embed: { ...allOn, subtitles: false } }).join(' ')).not.toContain('subs');
    expect(buildYtDlpArgs({ ...base, preset: 'compat', embed: { ...allOn, subtitles: false, autoSubtitles: true } }).join(' ')).toContain('--write-auto-subs --sub-langs');
  });
  it('limits the rate and cuts sections at exact points', () => {
    const a = buildYtDlpArgs({ ...base, preset: 'compat', rateLimitMBps: 2.5, section: { start: 600, end: 930 } });
    expect(a.join(' ')).toContain('-r 2.5M');
    expect(a.join(' ')).toContain('--download-sections *10:00-15:30 --force-keyframes-at-cuts');
    expect(a[a.indexOf('-o') + 1]).toBe('%(title).150B [%(id)s] [10m00s-15m30s].%(ext)s');
    expect(buildYtDlpArgs({ ...base, preset: 'compat', rateLimitMBps: 0 })).not.toContain('-r');
    expect(outputTemplate(2, undefined, { start: 0, end: 60 })).toBe('%(title).150B [%(id)s] [0m00s-1m00s] (2).%(ext)s');
  });
  it('a part has its own history identity', () => {
    const v = { url: 'https://youtu.be/a', extractor: 'Youtube', id: 'a' };
    expect(historyKey({ ...v, section: { start: 0, end: 60 } })).toBe('youtube:a#[0m00s-1m00s]');
    expect(historyKey(v)).toBe('youtube:a');
  });
});

describe('cover art is not the video', () => {
  it('evaluateProbe picks the real video stream index', () => {
    const r = evaluateProbe(
      { streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }, { index: 1, codec_type: 'video', codec_name: 'h264' }, { index: 2, codec_type: 'audio', codec_name: 'aac' }, { index: 3, codec_type: 'subtitle', codec_name: 'mov_text' }], format: { duration: '10' } },
      { duration: 10, expectVideo: true, expectAudio: true },
    );
    expect(r).toMatchObject({ ok: true, videoCodec: 'h264', videoIndex: 1, audioIndex: 2 });
  });

  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
  // Note: the MP4 muxer always moves cover art to the last stream, so in MP4 "v:0" is the real
  // video anyway; selecting by index is defensive. This checks cover + subtitles don't disturb
  // verification and gaps are still found.
  it.skipIf(!hasFfmpeg)('verifies files with cover art and subtitles, and still finds gaps in them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-f4-'));
    const src = join(dir, 'src.ts');
    const cover = join(dir, 'cover.jpg');
    const srt = join(dir, 'sub.srt');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:size=160x90', '-frames:v', '1', cover]);
    require('node:fs').writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nMerhaba\n');
    const mux = (input: string, out: string) =>
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', cover, '-i', input, '-i', srt, '-map', '0', '-map', '1:v', '-map', '1:a', '-map', '2',
        '-c', 'copy', '-c:s', 'mov_text', '-disposition:v:0', 'attached_pic', out]);
    const exp = { duration: 20, expectVideo: true, expectAudio: true };

    const good = join(dir, 'good.mp4');
    mux(src, good);
    expect(await verifyFile('ffprobe', good, exp)).toMatchObject({ ok: true, videoCodec: 'h264', audioCodec: 'aac' });

    const holed = join(dir, 'holed.ts');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c', 'copy', '-bsf:v', 'noise=drop=between(pts*tb\\,8\\,12)', '-bsf:a', 'noise=drop=between(pts*tb\\,8\\,12)', holed]);
    const bad = join(dir, 'bad.mp4');
    mux(holed, bad);
    const r = await verifyFile('ffprobe', bad, exp);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/Görüntü akışında 1 boşluk/);
  });
});
