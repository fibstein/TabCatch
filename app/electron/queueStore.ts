import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QueueItem } from './downloader';

export interface SavedQueue {
  version: 1;
  userPaused: boolean;
  items: QueueItem[];
}

export function loadQueue(file: string): SavedQueue | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as SavedQueue;
    if (data?.version !== 1 || !Array.isArray(data.items)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Debounced, atomic (tmp + rename) writer so a crash never leaves a half-written queue. */
export class QueueSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: SavedQueue | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly delayMs = 500,
  ) {}

  schedule(data: SavedQueue) {
    this.pending = data;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const data = this.pending;
    this.pending = null;
    if (!data) return this.writing;
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
