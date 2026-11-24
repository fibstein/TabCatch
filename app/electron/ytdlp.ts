export type FormatPreset = 'compat' | 'compat1080' | 'best' | 'audio';

export interface YtDlpArgsOptions {
  url: string;
  outputDir: string;
  preset: FormatPreset;
  ffmpegDir: string;
  denoPath: string;
  /** Retry after a failed integrity check: don't resume a possibly broken partial file. */
  fresh?: boolean;
  cookiesFile?: string;
  /** >1 when the default file name is taken by another video. */
  outputSuffix?: number;
}

export function outputTemplate(suffix?: number): string {
  return suffix && suffix > 1 ? `%(title).150B [%(id)s] (${suffix}).%(ext)s` : '%(title).150B [%(id)s].%(ext)s';
}

export const PROGRESS_PREFIX = 'TABCATCH_PROGRESS ';
export const RESULT_PREFIX = 'TABCATCH_RESULT ';

const FASTSTART = ['--postprocessor-args', 'Merger+ffmpeg_o:-movflags +faststart'];

export function presetArgs(preset: FormatPreset): string[] {
  switch (preset) {
    // H.264 + AAC in MP4: decoded in hardware almost everywhere, so seeking stays smooth in
    // Windows' built-in players. "vcodec:h264" = best codec no better than h264.
    case 'compat':
      return ['-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4', ...FASTSTART];
    case 'compat1080':
      return ['-S', 'vcodec:h264,res:1080,acodec:m4a', '--merge-output-format', 'mp4', ...FASTSTART];
    // Highest quality (often AV1/VP9 + Opus). MKV holds any codec combination.
    case 'best':
      return ['--merge-output-format', 'mkv'];
    case 'audio':
      return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
}

export function buildYtDlpArgs(o: YtDlpArgsOptions): string[] {
  const args = [
    '--newline',
    '--progress',
    '--no-simulate',
    '--no-playlist',
    '--no-colors',
    // Kept per item so a broken file can be traced to its format / downloader / skipped fragments.
    '--verbose',
    '--progress-template',
    `download:${PROGRESS_PREFIX}%(progress)j`,
    '--print',
    `after_move:${RESULT_PREFIX}%(.{filepath,duration,id,title,ext,vcodec,acodec,extractor_key,webpage_url})j`,
    // yt-dlp skips missing HLS/DASH fragments by default and still reports success,
    // which produces files that freeze or jump when seeking. Fail loudly instead.
    '--abort-on-unavailable-fragments',
    '--fragment-retries',
    '20',
    '--retries',
    '10',
    '--fixup',
    'detect_or_warn',
    '--ffmpeg-location',
    o.ffmpegDir,
    '--js-runtimes',
    `deno:${o.denoPath}`,
    '-P',
    o.outputDir,
    '-o',
    outputTemplate(o.outputSuffix),
    ...presetArgs(o.preset),
  ];
  if (o.fresh) args.push('--no-continue', '--force-overwrites');
  if (o.cookiesFile) args.push('--cookies', o.cookiesFile);
  args.push('--', o.url);
  return args;
}

export interface ProgressInfo {
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
  fragmentIndex: number | null;
  fragmentCount: number | null;
  status: string;
}

export interface ResultInfo {
  filepath: string;
  duration: number | null;
  id?: string;
  title?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  extractor?: string;
  webpageUrl?: string;
}

export type ParsedLine =
  | { kind: 'progress'; progress: ProgressInfo }
  | { kind: 'result'; result: ResultInfo }
  | { kind: 'log'; text: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseYtDlpLine(line: string): ParsedLine {
  const text = line.trimEnd();
  if (text.startsWith(PROGRESS_PREFIX)) {
    try {
      const p = JSON.parse(text.slice(PROGRESS_PREFIX.length)) as Record<string, unknown>;
      const downloaded = num(p.downloaded_bytes);
      const total = num(p.total_bytes) ?? num(p.total_bytes_estimate);
      const fi = num(p.fragment_index);
      const fc = num(p.fragment_count);
      let percent: number | null = null;
      if (downloaded !== null && total) percent = Math.min(100, (downloaded / total) * 100);
      else if (fi !== null && fc) percent = Math.min(100, (fi / fc) * 100);
      if (p.status === 'finished') percent = 100;
      return {
        kind: 'progress',
        progress: {
          percent,
          downloadedBytes: downloaded,
          totalBytes: total,
          speed: num(p.speed),
          eta: num(p.eta),
          fragmentIndex: fi,
          fragmentCount: fc,
          status: String(p.status ?? ''),
        },
      };
    } catch {
      return { kind: 'log', text };
    }
  }
  if (text.startsWith(RESULT_PREFIX)) {
    try {
      const r = JSON.parse(text.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
      if (typeof r.filepath === 'string') {
        return {
          kind: 'result',
          result: {
            filepath: r.filepath,
            duration: num(r.duration),
            id: typeof r.id === 'string' ? r.id : undefined,
            title: typeof r.title === 'string' ? r.title : undefined,
            ext: typeof r.ext === 'string' ? r.ext : undefined,
            vcodec: typeof r.vcodec === 'string' ? r.vcodec : undefined,
            acodec: typeof r.acodec === 'string' ? r.acodec : undefined,
            extractor: typeof r.extractor_key === 'string' ? r.extractor_key : undefined,
            webpageUrl: typeof r.webpage_url === 'string' ? r.webpage_url : undefined,
          },
        };
      }
    } catch {
      /* fall through */
    }
  }
  return { kind: 'log', text };
}
