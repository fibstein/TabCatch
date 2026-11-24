import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseYtDlpLine, type ProgressInfo, type ResultInfo } from './ytdlp';
import type { VerifyResult } from './verify';

export type ItemStatus = 'queued' | 'downloading' | 'verifying' | 'done' | 'verify_failed' | 'error' | 'canceled';

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
}

const MAX_LOG_LINES = 400;

export class DownloadQueue extends EventEmitter {
  private items: QueueItem[] = [];
  private current: { item: QueueItem; handle: RunHandle | null; canceled: boolean } | null = null;
  private paused = false;

  constructor(private readonly deps: DownloaderDeps) {
    super();
  }

  list(): QueueItem[] {
    return this.items.map((i) => ({ ...i, log: [] }));
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  isBusy(): boolean {
    return this.current !== null || this.items.some((i) => i.status === 'queued');
  }

  /** Stop starting new items (used while dependencies are being updated). */
  setPaused(p: boolean) {
    this.paused = p;
    if (!p) this.pump();
  }

  add(entries: { url: string; title: string; browser?: string; clientId?: string; tabId?: number }[]): QueueItem[] {
    const active = new Set(
      this.items.filter((i) => i.status === 'queued' || i.status === 'downloading').map((i) => i.url),
    );
    const added: QueueItem[] = [];
    for (const e of entries) {
      if (active.has(e.url)) continue;
      active.add(e.url);
      const item: QueueItem = {
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
      this.current.canceled = true;
      this.current.handle?.kill();
      return;
    }
    const item = this.get(id);
    if (item && item.status === 'queued') {
      item.status = 'canceled';
      this.changed();
    }
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
    if (this.current || this.paused) return;
    const next = this.items.find((i) => i.status === 'queued');
    if (!next) {
      this.emit('idle');
      return;
    }
    void this.run(next);
  }

  private async run(item: QueueItem) {
    item.status = 'downloading';
    item.attempts += 1;
    item.progress = null;
    item.result = undefined;
    item.verify = undefined;
    item.log.push(`--- deneme ${item.attempts}${item.fresh ? ' (sıfırdan)' : ''} ---`);
    const current: { item: QueueItem; handle: RunHandle | null; canceled: boolean } = { item, handle: null, canceled: false };
    this.current = current;
    this.changed();

    let args: string[] | null = null;
    try {
      args = await this.deps.buildArgs(item);
    } catch (err) {
      item.log.push(`Hazırlık başarısız: ${(err as Error).message}`);
    }
    if (!args || current.canceled) {
      await this.deps.afterRun?.(item).catch(() => undefined);
      this.current = null;
      item.status = current.canceled ? 'canceled' : 'error';
      if (!current.canceled) item.error = item.log[item.log.length - 1];
      this.changed();
      this.deps.onFinished?.(item);
      this.pump();
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
    const canceled = current.canceled;
    this.current = null;

    if (canceled) {
      item.status = 'canceled';
    } else if (code !== 0) {
      item.status = 'error';
      item.error = lastError(item.log) ?? `yt-dlp çıkış kodu ${code}`;
    } else if (!item.result) {
      item.status = 'error';
      item.error = 'yt-dlp dosya yolunu bildirmedi';
    } else {
      await this.verifyItem(item, item.result);
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
    if (log[i].startsWith('ERROR:')) return log[i].slice(6).trim();
  }
  return undefined;
}
