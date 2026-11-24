import { describe, expect, it, vi } from 'vitest';
import { DownloadQueue, type QueueItem, type RunHandle } from '../app/electron/downloader';
import { RESULT_PREFIX } from '../app/electron/ytdlp';
import type { VerifyResult } from '../app/electron/verify';

/** Fake yt-dlp: each run is controlled by the test. */
function fakeRunner() {
  const runs: { args: string[]; emit: (l: string) => void; finish: (code: number) => void; killed: boolean }[] = [];
  const runner = (args: string[]): RunHandle => {
    let cb: (l: string) => void = () => {};
    let finish!: (c: number) => void;
    const done = new Promise<number>((r) => (finish = r));
    const run = { args, emit: (l: string) => cb(l), finish, killed: false };
    runs.push(run);
    return { onLine: (c) => (cb = c), done, kill: () => ((run.killed = true), finish(137)) };
  };
  return { runs, runner };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ok: VerifyResult = { ok: true, problems: [], actualDuration: 10 };
const bad: VerifyResult = { ok: false, problems: ['Süre uyuşmuyor'], actualDuration: 4 };

function setup(
  verify: (item: QueueItem) => VerifyResult = () => ok,
  buildArgs: (item: QueueItem) => string[] | Promise<string[]> = (item) => [item.url, item.fresh ? 'fresh' : 'resume'],
) {
  const { runs, runner } = fakeRunner();
  const deleteFile = vi.fn(async () => {});
  const afterRun = vi.fn(async (_item: QueueItem) => {});
  const finished: QueueItem[] = [];
  const q = new DownloadQueue({
    runner,
    buildArgs,
    afterRun,
    verify: async (item) => verify(item),
    deleteFile,
    onFinished: (i) => finished.push({ ...i }),
  });
  const succeed = async (i: number, file = `/out/${i}.mp4`) => {
    runs[i].emit(RESULT_PREFIX + JSON.stringify({ filepath: file, duration: 10 }));
    runs[i].finish(0);
    await tick();
    await tick();
  };
  return { q, runs, deleteFile, afterRun, finished, succeed };
}

describe('DownloadQueue', () => {
  it('downloads one at a time, in order', async () => {
    const { q, runs, succeed } = setup();
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    await tick();
    expect(runs.map((r) => r.args[0])).toEqual(['a']);
    await succeed(0);
    expect(runs.map((r) => r.args[0])).toEqual(['a', 'b']);
    await succeed(1);
    expect(q.list().map((i) => i.status)).toEqual(['done', 'done']);
  });

  it('marks failures and continues with the next item', async () => {
    const { q, runs, succeed } = setup();
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    await tick();
    runs[0].emit('ERROR: [youtube] a: Video unavailable');
    runs[0].finish(1);
    await tick();
    expect(q.list()[0]).toMatchObject({ status: 'error', error: '[youtube] a: Video unavailable' });
    expect(runs).toHaveLength(2);
    await succeed(1);
    expect(q.list()[1].status).toBe('done');
  });

  it('cancels the running item', async () => {
    const { q, runs } = setup();
    const [item] = q.add([{ url: 'a', title: 'A' }]);
    await tick();
    q.cancel(item.id);
    await tick();
    expect(runs[0].killed).toBe(true);
    expect(q.list()[0].status).toBe('canceled');
  });

  it('ignores duplicates already in the queue', async () => {
    const { q } = setup();
    q.add([{ url: 'a', title: 'A' }]);
    await tick();
    expect(q.add([{ url: 'a', title: 'A again' }, { url: 'b', title: 'B' }])).toHaveLength(1);
  });

  it('re-downloads from scratch once when verification fails, then gives up', async () => {
    const { q, runs, deleteFile, succeed, finished } = setup(() => bad);
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    await tick();
    await succeed(0);
    expect(deleteFile).toHaveBeenCalledWith('/out/0.mp4');
    // The retry jumps ahead of "b" and must not resume the old partial data.
    expect(runs[1].args).toEqual(['a', 'fresh']);
    await succeed(1);
    expect(q.list()[0]).toMatchObject({ status: 'verify_failed', verifyRetries: 1 });
    expect(finished.map((f) => f.status)).toEqual(['verify_failed']);
    expect(runs[2].args[0]).toBe('b');
  });

  it('manual retry after verify failure downloads fresh', async () => {
    let calls = 0;
    const { q, runs, succeed } = setup(() => (++calls <= 2 ? bad : ok));
    const [item] = q.add([{ url: 'a', title: 'A' }]);
    await tick();
    await succeed(0);
    await succeed(1);
    expect(q.get(item.id)!.status).toBe('verify_failed');
    q.retry(item.id);
    await tick();
    expect(runs[2].args).toEqual(['a', 'fresh']);
    await succeed(2);
    expect(q.get(item.id)!.status).toBe('done');
  });

  it('cleans up after every run (cookie file), including failed ones', async () => {
    const { q, runs, afterRun, succeed } = setup();
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    await tick();
    expect(afterRun).not.toHaveBeenCalled();
    runs[0].finish(1);
    await tick();
    expect(afterRun).toHaveBeenCalledTimes(1);
    await succeed(1);
    expect(afterRun).toHaveBeenCalledTimes(2);
  });

  it('can be canceled while preparing (fetching cookies) and never starts yt-dlp', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { q, runs, afterRun } = setup(undefined, async (item) => {
      await gate;
      return [item.url];
    });
    const [item] = q.add([{ url: 'a', title: 'A' }]);
    await tick();
    q.cancel(item.id);
    release();
    await tick();
    await tick();
    expect(runs).toHaveLength(0);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(q.get(item.id)!.status).toBe('canceled');
  });

  it('marks an item as failed when preparation throws, and moves on', async () => {
    const { q, runs } = setup(undefined, (item) => {
      if (item.url === 'a') throw new Error('boom');
      return [item.url];
    });
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    await tick();
    await tick();
    expect(q.list()[0]).toMatchObject({ status: 'error', error: 'Hazırlık başarısız: boom' });
    expect(runs.map((r) => r.args[0])).toEqual(['b']);
  });
});
