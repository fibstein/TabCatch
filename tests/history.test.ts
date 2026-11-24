import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { History, historyKey, normalizeUrl } from '../app/electron/history';
import { loadQueue, QueueSaver } from '../app/electron/queueStore';

describe('historyKey', () => {
  it('uses extractor:id for real extractors and the URL for generic ones', () => {
    expect(historyKey({ url: 'https://youtu.be/abc', extractor: 'Youtube', id: 'abc' })).toBe('youtube:abc');
    expect(historyKey({ url: 'https://www.youtube.com/watch?v=abc', extractor: 'Youtube', id: 'abc' })).toBe('youtube:abc');
    // Two different streams both get id "index" from the generic extractor.
    expect(historyKey({ url: 'https://a.com/x/index.m3u8', extractor: 'Generic', id: 'index' })).not.toBe(
      historyKey({ url: 'https://b.com/y/index.m3u8', extractor: 'Generic', id: 'index' }),
    );
  });
  it('normalizes URLs', () => {
    expect(normalizeUrl('https://Site.com/v/1/#t=10')).toBe('https://site.com/v/1');
  });
});

describe('History', () => {
  it('finds earlier downloads only while the file exists, and persists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hist-'));
    const file = join(dir, 'v.mp4');
    writeFileSync(file, 'x');
    const h = new History(join(dir, 'history.json'));
    await h.add({ url: 'https://youtu.be/abc', extractor: 'Youtube', id: 'abc', filepath: file });
    expect(await h.existing({ url: 'https://youtu.be/abc#x' })).toMatchObject({ filepath: file });
    expect(await h.existing({ url: 'https://www.youtube.com/watch?v=abc', extractor: 'Youtube', id: 'abc' })).toMatchObject({ filepath: file });
    expect(h.findByPath(file)?.key).toBe('youtube:abc');

    const reloaded = new History(join(dir, 'history.json'));
    expect(reloaded.all()).toHaveLength(1);
    rmSync(file);
    expect(await reloaded.existing({ url: 'https://youtu.be/abc' })).toBeNull();
  });
  it('a re-download replaces the old entry for the same video or path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hist-'));
    const h = new History(join(dir, 'history.json'));
    await h.add({ url: 'https://youtu.be/abc', extractor: 'Youtube', id: 'abc', filepath: '/a.mp4' });
    await h.add({ url: 'https://youtu.be/abc', extractor: 'Youtube', id: 'abc', filepath: '/b.mp4' });
    expect(h.all().map((e) => e.filepath)).toEqual(['/b.mp4']);
  });
});

describe('QueueSaver', () => {
  it('writes the last scheduled state atomically and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-q-'));
    const file = join(dir, 'queue.json');
    const saver = new QueueSaver(file, 10_000);
    saver.schedule({ version: 1, userPaused: false, items: [] });
    saver.schedule({ version: 1, userPaused: true, items: [{ id: '1', url: 'u', title: 't', status: 'queued' } as never] });
    await saver.flush();
    expect(loadQueue(file)).toMatchObject({ userPaused: true, items: [{ id: '1' }] });
    writeFileSync(file, '{broken');
    expect(loadQueue(file)).toBeNull();
  });
});
