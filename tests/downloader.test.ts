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

function setup(verify: (item: QueueItem) => VerifyResult = () => ok) {
  const { runs, runner } = fakeRunner();
  const deleteFile = vi.fn(async () => {});
  const finished: QueueItem[] = [];
  const q = new DownloadQueue({
    runner,
    buildArgs: (item) => [item.url, item.fresh ? 'fresh' : 'resume'],
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
  return { q, runs, deleteFile, finished, succeed };
}

describe('DownloadQueue', () => {
  it('downloads one at a time, in order', async () => {
    const { q, runs, succeed } = setup();
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
    expect(runs.map((r) => r.args[0])).toEqual(['a']);
    await succeed(0);
    expect(runs.map((r) => r.args[0])).toEqual(['a', 'b']);
    await succeed(1);
    expect(q.list().map((i) => i.status)).toEqual(['done', 'done']);
  });

  it('marks failures and continues with the next item', async () => {
    const { q, runs, succeed } = setup();
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
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
    q.cancel(item.id);
    await tick();
    expect(runs[0].killed).toBe(true);
    expect(q.list()[0].status).toBe('canceled');
  });

  it('ignores duplicates already in the queue', () => {
    const { q } = setup();
    q.add([{ url: 'a', title: 'A' }]);
    expect(q.add([{ url: 'a', title: 'A again' }, { url: 'b', title: 'B' }])).toHaveLength(1);
  });

  it('re-downloads from scratch once when verification fails, then gives up', async () => {
    const { q, runs, deleteFile, succeed, finished } = setup(() => bad);
    q.add([{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }]);
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
    await succeed(0);
    await succeed(1);
    expect(q.get(item.id)!.status).toBe('verify_failed');
    q.retry(item.id);
    expect(runs[2].args).toEqual(['a', 'fresh']);
    await succeed(2);
    expect(q.get(item.id)!.status).toBe('done');
  });
});
