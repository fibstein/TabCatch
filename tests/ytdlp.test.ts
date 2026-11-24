import { describe, expect, it } from 'vitest';
import { buildYtDlpArgs, parseYtDlpLine, PROGRESS_PREFIX, RESULT_PREFIX } from '../app/electron/ytdlp';

const base = { url: 'https://youtu.be/x', outputDir: '/out', ffmpegDir: '/bin', denoPath: '/bin/deno' };

describe('buildYtDlpArgs', () => {
  it('uses integrity-safe defaults', () => {
    const a = buildYtDlpArgs({ ...base, preset: 'compat' });
    expect(a).toContain('--abort-on-unavailable-fragments');
    expect(a.join(' ')).toContain('-S vcodec:h264,res,acodec:m4a --merge-output-format mp4');
    expect(a).toContain('Merger+ffmpeg_o:-movflags +faststart');
    expect(a.slice(-2)).toEqual(['--', 'https://youtu.be/x']);
    expect(a).not.toContain('--no-continue');
  });
  it('downloads from scratch when fresh', () => {
    const a = buildYtDlpArgs({ ...base, preset: 'best', fresh: true });
    expect(a).toContain('--no-continue');
    expect(a).toContain('--force-overwrites');
    expect(a).not.toContain('-S');
  });
  it('audio preset extracts mp3', () => {
    expect(buildYtDlpArgs({ ...base, preset: 'audio' }).join(' ')).toContain('-x --audio-format mp3');
  });
});

describe('parseYtDlpLine', () => {
  it('computes percent from bytes or fragments', () => {
    const p = parseYtDlpLine(PROGRESS_PREFIX + JSON.stringify({ status: 'downloading', downloaded_bytes: 50, total_bytes: 200, speed: 10, eta: 15 }));
    expect(p).toMatchObject({ kind: 'progress', progress: { percent: 25, speed: 10, eta: 15 } });
    const f = parseYtDlpLine(PROGRESS_PREFIX + JSON.stringify({ status: 'downloading', fragment_index: 3, fragment_count: 4, downloaded_bytes: 1 }));
    expect(f).toMatchObject({ progress: { percent: 75 } });
  });
  it('parses the final result line', () => {
    const r = parseYtDlpLine(RESULT_PREFIX + JSON.stringify({ filepath: 'C:\\v\\a.mp4', duration: 12.5, vcodec: 'avc1' }));
    expect(r).toMatchObject({ kind: 'result', result: { filepath: 'C:\\v\\a.mp4', duration: 12.5 } });
  });
  it('treats everything else as log', () => {
    expect(parseYtDlpLine('[youtube] x: Downloading webpage')).toEqual({ kind: 'log', text: '[youtube] x: Downloading webpage' });
    expect(parseYtDlpLine(PROGRESS_PREFIX + 'NA')).toMatchObject({ kind: 'log' });
  });
});
