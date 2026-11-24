// Classification of network responses seen in a tab: which ones are downloadable videos.

export type MediaKind = 'hls' | 'dash' | 'file';

export interface MediaCandidate {
  url: string;
  kind: MediaKind;
  contentType?: string;
  /** Total size in bytes when the server told us (progressive files). */
  size?: number;
  seenAt: number;
}

export const MAX_CANDIDATES_PER_TAB = 20;
const MIN_FILE_SIZE = 300 * 1024; // smaller "videos" are previews, ads, UI animations

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_TYPES = ['application/dash+xml'];
const FILE_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-m4v'];
const SEGMENT_TYPES = ['video/mp2t', 'video/iso.segment', 'audio/aac'];

/** Hosts whose media requests are signed per-request fragments of a site yt-dlp handles itself. */
const IGNORED_HOSTS = ['googlevideo.com', 'youtube.com', 'ytimg.com', 'doubleclick.net', 'googlesyndication.com'];

/** Fragment / chunk naming used by HLS and DASH players for individual pieces. */
const SEGMENT_NAME = /(^|[/_\-.])(seg|segment|chunk|frag|fragment|part)[-_]?\d+/i;

function header(headers: { name: string; value?: string }[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

/** Total size from Content-Range ("bytes 0-99/12345") or Content-Length. */
export function totalSize(status: number, headers?: { name: string; value?: string }[]): number | undefined {
  const range = header(headers, 'content-range');
  const m = range?.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, 'content-length'));
  return status === 200 && Number.isFinite(len) && len > 0 ? len : undefined;
}

export function classifyMedia(
  url: string,
  status: number,
  headers?: { name: string; value?: string }[],
): Omit<MediaCandidate, 'seenAt'> | null {
  if (status >= 400) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (IGNORED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;

  const contentType = header(headers, 'content-type')?.split(';')[0].trim().toLowerCase();
  const path = u.pathname.toLowerCase();
  const ext = path.match(/\.([a-z0-9]+)$/)?.[1];

  if (ext === 'm3u8' || (contentType && HLS_TYPES.includes(contentType))) return { url, kind: 'hls', contentType };
  if (ext === 'mpd' || (contentType && DASH_TYPES.includes(contentType))) return { url, kind: 'dash', contentType };

  if (ext === 'ts' || ext === 'm4s' || ext === 'aac' || ext === 'vtt' || (contentType && SEGMENT_TYPES.includes(contentType))) return null;
  const isVideoExt = ext !== undefined && ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext);
  const isVideoType = contentType !== undefined && FILE_TYPES.includes(contentType);
  if (!isVideoExt && !isVideoType) return null;
  if (SEGMENT_NAME.test(path) || u.searchParams.has('range') || u.searchParams.has('bytestart')) return null;
  const size = totalSize(status, headers);
  if (size !== undefined && size < MIN_FILE_SIZE) return null;
  return { url, kind: 'file', contentType, size };
}

/** Newest first, one entry per URL, capped. */
export function addCandidate(list: MediaCandidate[], c: MediaCandidate): MediaCandidate[] {
  const rest = list.filter((x) => x.url !== c.url);
  return [c, ...rest].slice(0, MAX_CANDIDATES_PER_TAB);
}

/** Streaming manifests first (the first one seen is usually the master playlist), then big files. */
export function rankCandidates(list: MediaCandidate[]): MediaCandidate[] {
  const order = { hls: 0, dash: 0, file: 1 } as const;
  return [...list].sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === 'file' ? (b.size ?? 0) - (a.size ?? 0) : a.seenAt - b.seenAt));
}

/**
 * yt-dlp writes literal template text into the file name unescaped, so the tab title has to be
 * made safe for Windows file names here (and `%` escaped for the template).
 */
export function safeTitle(title: string, max = 150): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const cut = [...cleaned].slice(0, max).join('');
  return (cut || 'video').replace(/%/g, '%%');
}
