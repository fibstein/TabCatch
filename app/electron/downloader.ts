import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseYtDlpLine, type ProgressInfo, type ResultInfo } from './ytdlp';
import type { VerifyResult } from './verify';

export type ItemStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'paused'
  | 'done'
  | 'skipped'
  | 'verify_failed'
  | 'error'
  | 'canceled';

export interface QueueItem {
  id: string;
  url: string;
  title: string;
  browser?: string;
  /** Bridge connection and tab the URL came from; used to fetch that browser's cookies. */
  clientId?: string;
  tabId?: number;
  /** What happened with cookies on the last run, shown in the UI (never the cookies themselves). */
  cookieNote?: string;
  status: ItemStatus;
  progress: ProgressInfo | null;
  result?: ResultInfo;
  verify?: VerifyResult;
  error?: string;
  /** Number of yt-dlp runs started for this item. */
  attempts: number;
  /** Next run must not resume partial data (set after a failed integrity check). */
  fresh: boolean;
  /** Automatic re-downloads already done because of failed integrity checks. */
  verifyRetries: number;
  /** >1 when another video already owns the default file name: "<title> [id] (n).ext". */
  outputSuffix?: number;
  /** Download even if the history says this video was downloaded before. */
  force?: boolean;
  /** From the pre-check, when known: lets the history recognise the video under another URL. */
  extractor?: string;
  videoId?: string;
  /** Set for a stream captured from the page's network traffic: the page it was playing on. */
  pageUrl?: string;
  log: string[];
  addedAt: number;
}

export interface RunHandle {
  onLine(cb: (line: string) => void): void;
  done: Promise<number>;
  kill(): void;
}

export type Runner = (args: string[]) => RunHandle;

export interface DownloaderDeps {
  runner: Runner;
  /** May be async (e.g. fetches cookies from the browser before the download starts). */
  buildArgs(item: QueueItem): string[] | Promise<string[]>;
  /** Called once yt-dlp has exited (or never started); used to delete the temporary cookie file. */
  afterRun?(item: QueueItem): Promise<void>;
  verify(item: QueueItem, result: ResultInfo): Promise<VerifyResult>;
  deleteFile(path: string): Promise<void>;
  /** Automatic re-downloads after a failed integrity check. */
  maxVerifyRetries?: number;
  onFinished?(item: QueueItem): void;
  /** Before starting: an existing download of the same video, if it should be skipped. */
  findExisting?(item: QueueItem): Promise<string | null>;
  /**
   * yt-dlp reported "has already been downloaded": true when that file belongs to a different
   * video (same title + id from another site), so this item must be saved under another name.
   */
  isNameCollision?(item: QueueItem, result: ResultInfo): Promise<boolean>;
}

const RESTARTABLE: ItemStatus[] = ['downloading', 'verifying'];
const MAX_OUTPUT_SUFFIX = 20;

const MAX_LOG_LINES = 400;

export class DownloadQueue extends EventEmitter {
  private items: QueueItem[] = [];
  private current: Current | null = null;
  /** Dependency install in progress (Windows locks running executables). */
  private depsPaused = false;
  /** "Kuyruğu duraklat" button. */
  private userPaused = false;

  constructor(private readonly deps: DownloaderDeps) {
    super();
  }

  list(): QueueItem[] {
    return this.items.map((i) => ({ ...i, log: [] }));
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** True while yt-dlp runs or is about to run (the executable must not be replaced then). */
  isBusy(): boolean {
    if (this.current !== null) return true;
    // Queued items waiting on a pause (e.g. dependencies not installed yet) don't block installs.
    return !this.userPaused && !this.depsPaused && this.items.some((i) => i.status === 'queued');
  }

  /** Stop starting new items while dependencies are installed / missing. */
  setPaused(p: boolean) {
    this.depsPaused = p;
    if (!p) this.pump();
  }

  isUserPaused(): boolean {
    return this.userPaused;
  }

  /** Global pause: the running download is stopped (kept resumable) and nothing new starts. */
  setUserPaused(p: boolean) {
    this.userPaused = p;
    if (p && this.current) this.pause(this.current.item.id);
    this.changed();
    if (!p) this.pump();
  }

  /** Items without logs, for saving to disk. */
  snapshot(): QueueItem[] {
    return this.list();
  }

  /** Loads a saved queue. Interrupted downloads go back to the queue; yt-dlp resumes the .part file. */
  restore(items: QueueItem[], userPaused = false) {
    this.userPaused = userPaused;
    this.items = items.map((i) => ({
      ...i,
      status: RESTARTABLE.includes(i.status) ? 'queued' : i.status,
      progress: null,
      log: [],
    }));
    this.changed();
    this.pump();
  }

  add(entries: NewItem[]): QueueItem[] {
    const active = new Set(
      this.items.filter((i) => i.status === 'queued' || i.status === 'downloading').map((i) => i.url),
    );
    const added: QueueItem[] = [];
    for (const e of entries) {
      if (active.has(e.url)) continue;
      active.add(e.url);
      const item: QueueItem = {
        force: e.force,
        extractor: e.extractor,
        videoId: e.videoId,
        pageUrl: e.pageUrl,
        id: randomUUID(),
        url: e.url,
        title: e.title,
        browser: e.browser,
        clientId: e.clientId,
        tabId: e.tabId,
        status: 'queued',
        progress: null,
        attempts: 0,
        fresh: false,
        verifyRetries: 0,
        log: [],
        addedAt: Date.now(),
      };
      this.items.push(item);
      added.push(item);
    }
    this.changed();
    this.pump();
    return added;
  }

  cancel(id: string) {
    if (this.current?.item.id === id) {
      this.current.stop = 'cancel';
      this.current.handle?.kill();
      return;
    }
    const item = this.get(id);
    if (item && (item.status === 'queued' || item.status === 'paused')) {
      item.status = 'canceled';
      this.changed();
    }
  }

  /** Stops without discarding: the partial file stays and the next run continues it. */
  pause(id: string) {
    if (this.current?.item.id === id) {
      if (this.current.item.status === 'verifying') return; // nearly done, let it finish
      this.current.stop = 'pause';
      this.current.handle?.kill();
      return;
    }
    const item = this.get(id);
    if (item?.status === 'queued') {
      item.status = 'paused';
      this.changed();
    }
  }

  resume(id: string) {
    const item = this.get(id);
    if (item?.status !== 'paused') return;
    item.status = 'queued';
    this.changed();
    this.pump();
  }

  /** "Yine de indir" for an item skipped because it was downloaded before. */
  forceDownload(id: string) {
    const item = this.get(id);
    if (item?.status !== 'skipped') return;
    item.force = true;
    item.status = 'queued';
    item.result = undefined;
    this.changed();
    this.pump();
  }

  retry(id: string) {
    const item = this.get(id);
    if (!item || !['error', 'canceled', 'verify_failed'].includes(item.status)) return;
    if (item.status === 'verify_failed') item.fresh = true;
    item.status = 'queued';
    item.error = undefined;
    item.progress = null;
    item.verifyRetries = 0;
    this.changed();
    this.pump();
  }

  remove(id: string) {
    if (this.current?.item.id === id) return;
    this.items = this.items.filter((i) => i.id !== id);
    this.changed();
  }

  update(id: string, patch: Partial<QueueItem>) {
    const item = this.get(id);
    if (!item) return;
    Object.assign(item, patch);
    this.changed();
  }

  private changed() {
    this.emit('update', this.list());
  }

  private pump() {
    if (this.current || this.depsPaused || this.userPaused) return;
    const next = this.items.find((i) => i.status === 'queued');
    if (!next) {
      this.emit('idle');
      return;
    }
    void this.run(next);
  }

  private finishEarly(item: QueueItem, status: ItemStatus) {
    this.current = null;
    item.status = status;
    this.changed();
    if (status !== 'paused') this.deps.onFinished?.(item);
    this.pump();
  }

  private async run(item: QueueItem) {
    const current: Current = { item, handle: null, stop: null };
    this.current = current;
    item.status = 'downloading';
    item.progress = null;
    item.verify = undefined;
    item.error = undefined;
    this.changed();

    if (!item.force && this.deps.findExisting) {
      const existing = await this.deps.findExisting(item).catch(() => null);
      if (existing) {
        item.result = { filepath: existing, duration: null };
        item.log.push(`Daha önce indirilmiş, atlandı: ${existing}`);
        this.finishEarly(item, current.stop === 'pause' ? 'paused' : current.stop === 'cancel' ? 'canceled' : 'skipped');
        return;
      }
    }

    item.attempts += 1;
    item.result = undefined;
    item.log.push(`--- deneme ${item.attempts}${item.fresh ? ' (sıfırdan)' : ''}${item.outputSuffix ? ` (dosya adı ${item.outputSuffix})` : ''} ---`);

    let args: string[] | null = null;
    try {
      args = await this.deps.buildArgs(item);
    } catch (err) {
      item.log.push(`Hazırlık başarısız: ${(err as Error).message}`);
    }
    if (!args || current.stop) {
      await this.deps.afterRun?.(item).catch(() => undefined);
      if (!current.stop) item.error = item.log[item.log.length - 1];
      this.finishEarly(item, current.stop === 'pause' ? 'paused' : current.stop === 'cancel' ? 'canceled' : 'error');
      return;
    }
    const handle = this.deps.runner(args);
    current.handle = handle;

    let lastEmit = 0;
    handle.onLine((line) => {
      const parsed = parseYtDlpLine(line);
      if (parsed.kind === 'progress') {
        item.progress = parsed.progress;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          this.changed();
        }
      } else if (parsed.kind === 'result') {
        item.result = parsed.result;
      } else if (parsed.text) {
        item.log.push(parsed.text);
        if (item.log.length > MAX_LOG_LINES) item.log.splice(0, item.log.length - MAX_LOG_LINES);
      }
    });

    let code: number;
    try {
      code = await handle.done;
    } catch (err) {
      code = -1;
      item.log.push(String(err));
    }
    await this.deps.afterRun?.(item).catch(() => undefined);
    this.current = null;
    // Set from the line callback; TypeScript can't see that and would narrow it to undefined.
    const result = item.result as ResultInfo | undefined;

    if (current.stop === 'cancel') {
      item.status = 'canceled';
    } else if (current.stop === 'pause') {
      item.status = 'paused';
      item.progress = null;
      this.changed();
      this.pump();
      return;
    } else if (code !== 0) {
      item.status = 'error';
      item.error = lastError(item.log) ?? `yt-dlp çıkış kodu ${code}`;
    } else if (!result) {
      item.status = 'error';
      item.error = 'yt-dlp dosya yolunu bildirmedi';
    } else if (
      item.log.some((l) => l.includes('has already been downloaded')) &&
      (await this.deps.isNameCollision?.(item, result).catch(() => false))
    ) {
      // Another video owns this file name; download again under "<name> (n)".
      const next = (item.outputSuffix ?? 1) + 1;
      if (next > MAX_OUTPUT_SUFFIX) {
        item.status = 'error';
        item.error = 'Aynı adlı çok fazla dosya var';
      } else {
        item.log.push(`Dosya adı başka bir videoya ait (${result.filepath}), farklı adla indirilecek`);
        item.outputSuffix = next;
        item.result = undefined;
        item.status = 'queued';
        this.items = [item, ...this.items.filter((i) => i !== item)];
      }
    } else {
      await this.verifyItem(item, result);
    }
    this.changed();
    // verifyItem may have re-queued the item for an automatic fresh download.
    if ((item.status as ItemStatus) !== 'queued') this.deps.onFinished?.(item);
    this.pump();
  }

  private async verifyItem(item: QueueItem, result: ResultInfo) {
    item.status = 'verifying';
    this.changed();
    let v: VerifyResult;
    try {
      v = await this.deps.verify(item, result);
    } catch (err) {
      v = { ok: false, problems: [`Doğrulama çalışmadı: ${(err as Error).message}`], actualDuration: null };
    }
    item.verify = v;
    if (v.ok) {
      item.status = 'done';
      item.fresh = false;
      return;
    }
    item.log.push(`Doğrulama başarısız: ${v.problems.join('; ')}`);
    if (item.verifyRetries < (this.deps.maxVerifyRetries ?? 1)) {
      item.verifyRetries += 1;
      // A resumed partial file may be the cause; delete and download from scratch, ahead of the rest.
      await this.deps.deleteFile(result.filepath).catch(() => undefined);
      item.fresh = true;
      item.status = 'queued';
      this.items = [item, ...this.items.filter((i) => i !== item)];
    } else {
      item.status = 'verify_failed';
      item.error = v.problems.join('; ');
    }
  }
}

function lastError(log: string[]): string | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    if (!log[i].startsWith('ERROR:')) continue;
    const msg = log[i].slice(6).trim();
    if (/DRM/i.test(msg)) return 'DRM korumalı içerik, indirilemez';
    return msg;
  }
  return undefined;
}

export interface NewItem {
  url: string;
  title: string;
  browser?: string;
  clientId?: string;
  tabId?: number;
  force?: boolean;
  extractor?: string;
  videoId?: string;
  pageUrl?: string;
}

interface Current {
  item: QueueItem;
  handle: RunHandle | null;
  stop: 'cancel' | 'pause' | null;
}
