import { execFile, spawn } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  disposition?: { attached_pic?: number };
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  actualDuration: number | null;
  videoCodec?: string;
  audioCodec?: string;
  /** ffprobe stream indexes of the real video/audio (not cover art or subtitles). */
  videoIndex?: number;
  audioIndex?: number;
}

export interface VerifyExpectations {
  duration: number | null;
  expectVideo: boolean;
  expectAudio: boolean;
}

/**
 * Merging/remuxing shifts the duration by well under a second. A lost HLS/DASH fragment is
 * typically 2-10 s, so the tolerance must stay below that: 2 s, or 0.5 % for long videos.
 */
export function durationMatches(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(2, expected * 0.005);
}

export function evaluateProbe(probe: ProbeJson, exp: VerifyExpectations): VerifyResult {
  const problems: string[] = [];
  const streams = probe.streams ?? [];
  // Embedded cover art is a one-frame "video" stream; it must not count as the video.
  const video = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1 && s.codec_name !== 'mjpeg' && s.codec_name !== 'png',
  );
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (exp.expectVideo && !video) problems.push('Video stream yok');
  if (exp.expectAudio && !audio) problems.push('Ses stream yok');
  const d = Number(probe.format?.duration);
  const actualDuration = Number.isFinite(d) && d > 0 ? d : null;
  if (actualDuration === null) problems.push('Süre okunamadı');
  else if (exp.duration && !durationMatches(actualDuration, exp.duration)) {
    problems.push(`Süre uyuşmuyor: dosya ${actualDuration.toFixed(1)} sn, beklenen ${exp.duration.toFixed(1)} sn`);
  }
  return {
    ok: problems.length === 0,
    problems,
    actualDuration,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    videoIndex: video?.index,
    audioIndex: audio?.index,
  };
}

function run(file: string, args: string[], timeout = 0): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

export async function probeFile(ffprobe: string, file: string): Promise<ProbeJson | null> {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as ProbeJson;
  } catch {
    return null;
  }
}

export interface TimestampGap {
  from: number;
  to: number;
}

/**
 * A lost HLS/DASH fragment leaves the container duration intact (timestamps continue after the
 * hole), so it only shows up as a jump in packet timestamps. This is the classic "freezes or
 * jumps when seeking" file. Backwards jumps (broken concatenation) are reported as well.
 */
export function detectGaps(dts: number[], threshold = 2): TimestampGap[] {
  const gaps: TimestampGap[] = [];
  for (let i = 1; i < dts.length; i++) {
    const delta = dts[i] - dts[i - 1];
    if (delta > threshold || delta < -0.5) gaps.push({ from: dts[i - 1], to: dts[i] });
  }
  return gaps;
}

/** Reads packet timestamps without decoding (I/O bound: seconds even for long videos). */
export function readPacketTimes(ffprobe: string, file: string, stream: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const times: number[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      const t = Number(line.split(',')[0]);
      if (line && Number.isFinite(t)) times.push(t);
    });
    child.once('error', reject);
    child.once('close', () => resolve(times));
  });
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function verifyFile(ffprobe: string, file: string, exp: VerifyExpectations): Promise<VerifyResult> {
  try {
    const s = await stat(file);
    if (s.size === 0) return { ok: false, problems: ['Dosya boş'], actualDuration: null };
  } catch {
    return { ok: false, problems: ['Dosya bulunamadı'], actualDuration: null };
  }
  const probe = await probeFile(ffprobe, file);
  if (!probe) return { ok: false, problems: ['ffprobe dosyayı açamadı'], actualDuration: null };
  const result = evaluateProbe(probe, exp);
  // Select by absolute index: "v:0" could be the cover art, which has a single packet.
  const streams: [string, string, boolean][] = [
    [String(result.videoIndex ?? 'v:0'), 'Görüntü', exp.expectVideo && !!result.videoCodec],
    [String(result.audioIndex ?? 'a:0'), 'Ses', exp.expectAudio && !!result.audioCodec],
  ];
  for (const [sel, label, present] of streams) {
    if (!present) continue;
    const times = await readPacketTimes(ffprobe, file, sel);
    const gaps = detectGaps(times);
    if (gaps.length) {
      // MPEG-TS starts at an arbitrary timestamp; show positions as the player does.
      const t0 = times[0];
      const list = gaps.slice(0, 3).map((g) => `${fmtTime(g.from - t0)} → ${fmtTime(g.to - t0)}`).join(', ');
      result.problems.push(`${label} akışında ${gaps.length} boşluk/sıçrama var (eksik parça): ${list}`);
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** Full decode; slow (roughly real-time / N) but catches corrupt frames that ffprobe misses. */
export async function deepCheck(ffmpeg: string, file: string): Promise<string[]> {
  const r = await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-']);
  return r.stderr.split(/\r?\n/).filter(Boolean).slice(0, 50);
}

export type RepairMode = 'remux' | 'reencode';

/**
 * Writes the repaired copy next to the original and swaps it in only after it verifies;
 * the original is kept as `.orig` so a bad repair can't lose the download.
 */
export async function repairFile(
  bins: { ffmpeg: string; ffprobe: string },
  file: string,
  mode: RepairMode,
  exp: VerifyExpectations,
): Promise<{ path: string; verify: VerifyResult }> {
  const ext = extname(file);
  const isAudio = !exp.expectVideo;
  const outExt = isAudio ? ext : '.mp4';
  const tmp = join(dirname(file), `${basename(file, ext)}.repair${outExt}`);
  const codec =
    mode === 'remux'
      ? ['-c', 'copy']
      : isAudio
        ? ['-c:a', 'libmp3lame', '-q:a', '0']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'];
  const args = ['-v', 'error', '-nostdin', '-y', '-fflags', '+genpts', '-i', file, '-map', '0:v?', '-map', '0:a?', ...codec];
  if (!isAudio) args.push('-movflags', '+faststart');
  args.push(tmp);
  const r = await run(bins.ffmpeg, args);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new Error(`ffmpeg ${mode} başarısız: ${r.stderr.split(/\r?\n/).slice(-3).join(' ')}`);
  }
  const verify = await verifyFile(bins.ffprobe, tmp, exp);
  if (!verify.ok) {
    await rm(tmp, { force: true });
    return { path: file, verify };
  }
  const finalPath = join(dirname(file), `${basename(file, ext)}${outExt}`);
  await rename(file, `${file}.orig`);
  await rename(tmp, finalPath);
  return { path: finalPath, verify };
}
