import { presetArgs, type FormatPreset } from './ytdlp';
import type { RunHandle } from './downloader';

export interface PlaylistEntry {
  url: string;
  title: string;
  id?: string;
  duration?: number;
}

export interface ProbeResult {
  url: string;
  supported: boolean;
  extractor?: string;
  id?: string;
  title?: string;
  duration?: number;
  /** Size of the format the current preset would pick (exact or estimated). */
  filesize?: number;
  maxHeight?: number;
  isLive?: boolean;
  isPlaylist: boolean;
  entryCount?: number;
  entries?: PlaylistEntry[];
  /** The URL also names a playlist (e.g. watch?v=x&list=y): offer to open it. */
  hasPlaylist: boolean;
  /** Earlier download of this video, if its file still exists. */
  alreadyDownloaded?: string;
  error?: string;
}

export const PLAYLIST_LIMIT = 500;

export function urlNamesPlaylist(url: string): boolean {
  try {
    const u = new URL(url);
    return u.searchParams.has('list') || /\/playlist\b|\/sets\/|\/album\//.test(u.pathname);
  } catch {
    return false;
  }
}

export function buildProbeArgs(o: { url: string; preset: FormatPreset; denoPath: string; playlist: boolean; cookiesFile?: string }): string[] {
  const args = [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--no-colors',
    '--js-runtimes',
    `deno:${o.denoPath}`,
    // Same format selection as the download, so the size estimate matches what will be fetched.
    ...presetArgs(o.preset),
  ];
  if (o.playlist) args.push('--yes-playlist', '-I', `:${PLAYLIST_LIMIT}`);
  else args.push('--no-playlist');
  if (o.cookiesFile) args.push('--cookies', o.cookiesFile);
  args.push('--', o.url);
  return args;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function parseProbeOutput(url: string, lines: string[], exitCode: number): ProbeResult {
  const base: ProbeResult = { url, supported: false, isPlaylist: false, hasPlaylist: urlNamesPlaylist(url) };
  const jsonLine = lines.find((l) => l.startsWith('{'));
  if (exitCode !== 0 || !jsonLine) {
    const err = [...lines].reverse().find((l) => l.startsWith('ERROR:'))?.slice(6).trim() ?? `yt-dlp çıkış kodu ${exitCode}`;
    return { ...base, error: /Unsupported URL/i.test(err) ? 'Bu sayfada yt-dlp video bulamadı' : err };
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(jsonLine) as Record<string, unknown>;
  } catch {
    return { ...base, error: 'yt-dlp çıktısı okunamadı' };
  }
  const common = {
    ...base,
    supported: true,
    extractor: str(j.extractor_key) ?? str(j.extractor),
    id: str(j.id),
    title: str(j.title),
  };
  if (j._type === 'playlist' || Array.isArray(j.entries)) {
    const entries: PlaylistEntry[] = [];
    const seen = new Set<string>();
    for (const e of (j.entries as unknown[] | undefined) ?? []) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      // `url` is the entry itself; for the generic extractor `webpage_url` is the parent page,
      // so preferring it would make every entry download the whole page again.
      const entryUrl = [str(r.url), str(r.webpage_url)].find((u) => u && /^https?:/.test(u) && u !== url);
      if (!entryUrl || seen.has(entryUrl)) continue;
      seen.add(entryUrl);
      entries.push({ url: entryUrl, title: str(r.title) ?? entryUrl, id: str(r.id), duration: num(r.duration) });
    }
    return { ...common, isPlaylist: true, hasPlaylist: true, entries, entryCount: num(j.playlist_count) ?? entries.length };
  }
  const requested = Array.isArray(j.requested_formats) ? (j.requested_formats as Record<string, unknown>[]) : [];
  const fromParts = requested.reduce((sum, f) => sum + (num(f.filesize) ?? num(f.filesize_approx) ?? 0), 0);
  const heights = (Array.isArray(j.formats) ? (j.formats as Record<string, unknown>[]) : []).map((f) => num(f.height) ?? 0);
  return {
    ...common,
    duration: num(j.duration),
    filesize: num(j.filesize) ?? num(j.filesize_approx) ?? (fromParts || undefined),
    maxHeight: num(j.height) ?? (heights.length ? Math.max(...heights) || undefined : undefined),
    isLive: j.is_live === true,
  };
}

export interface ProbeDeps {
  run(args: string[]): RunHandle;
  /** Builds the args (incl. a cookie file); `cleanup` deletes that file afterwards. */
  prepare(url: string, playlist: boolean, ctx: ProbeContext): Promise<{ args: string[]; cleanup(): Promise<void> }>;
  concurrency?: number;
  timeoutMs?: number;
  cacheMs?: number;
}

export interface ProbeContext {
  clientId?: string;
  tabId?: number;
  browser?: string;
}

/** Runs `yt-dlp -J` with limited parallelism, caching results per URL. */
export class ProbeService {
  private cache = new Map<string, { at: number; result: ProbeResult }>();
  private inflight = new Map<string, Promise<ProbeResult>>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private blocked = false;

  constructor(private readonly deps: ProbeDeps) {}

  activeCount(): number {
    return this.active;
  }

  /** While dependencies are replaced no new yt-dlp process may start. */
  setBlocked(b: boolean) {
    this.blocked = b;
  }

  cached(url: string, playlist = false): ProbeResult | undefined {
    const hit = this.cache.get(`${playlist ? 'P' : 'V'}:${url}`);
    return hit && Date.now() - hit.at < (this.deps.cacheMs ?? 10 * 60_000) ? hit.result : undefined;
  }

  probe(url: string, ctx: ProbeContext = {}, playlist = false): Promise<ProbeResult> {
    const key = `${playlist ? 'P' : 'V'}:${url}`;
    const hit = this.cached(url, playlist);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(url, ctx, playlist)
      .then((result) => {
        // Errors are not cached: the user may log in or the network may come back.
        if (result.supported) this.cache.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async slot(): Promise<void> {
    if (this.active < (this.deps.concurrency ?? 2)) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiting.shift()?.();
  }

  private async run(url: string, ctx: ProbeContext, playlist: boolean): Promise<ProbeResult> {
    await this.slot();
    try {
      if (this.blocked) return { url, supported: false, isPlaylist: false, hasPlaylist: false, error: 'Paketler güncelleniyor, birazdan tekrar dene' };
      const { args, cleanup } = await this.deps.prepare(url, playlist, ctx);
      try {
        const h = this.deps.run(args);
        const lines: string[] = [];
        h.onLine((l) => lines.push(l));
        const timer = setTimeout(() => h.kill(), this.deps.timeoutMs ?? 90_000);
        const code = await h.done.catch(() => -1);
        clearTimeout(timer);
        return parseProbeOutput(url, lines, code);
      } finally {
        await cleanup().catch(() => undefined);
      }
    } finally {
      this.release();
    }
  }
}
