import { readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sectionTag, type Section } from './ytdlp';

export interface HistoryEntry {
  key: string;
  url: string;
  extractor?: string;
  id?: string;
  filepath: string;
  size?: number;
  section?: Section;
  finishedAt: number;
}

type Identity = { url: string; extractor?: string; id?: string; section?: Section };

/** Same URL regardless of fragment / trailing slash / host case. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/**
 * Identity of a video. Site extractors give stable ids (youtube:abc). The generic extractor
 * derives the id from the file name ("index", "video"), so different videos share it; there the
 * URL is the only reliable identity. (This is also why yt-dlp's --download-archive isn't used.)
 */
export function historyKey(v: Identity): string {
  const ex = v.extractor?.toLowerCase();
  const base = ex && v.id && ex !== 'generic' ? `${ex}:${v.id}` : `url:${normalizeUrl(v.url)}`;
  // A cut-out part is a different file from the full video (and from other parts).
  return v.section ? `${base}#${sectionTag(v.section)}` : base;
}

const MAX_ENTRIES = 5000;

export class History {
  private entries: HistoryEntry[] = [];

  constructor(private readonly file: string) {
    try {
      this.entries = JSON.parse(readFileSync(file, 'utf8')) as HistoryEntry[];
    } catch {
      /* first run */
    }
  }

  all(): HistoryEntry[] {
    return [...this.entries];
  }

  findByKey(key: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  findByUrl(url: string, section?: Section): HistoryEntry | undefined {
    const n = normalizeUrl(url);
    const tag = section ? sectionTag(section) : undefined;
    return this.entries.find((e) => normalizeUrl(e.url) === n && (e.section ? sectionTag(e.section) : undefined) === tag);
  }

  findByPath(filepath: string): HistoryEntry | undefined {
    const p = samePath(filepath);
    return this.entries.find((e) => samePath(e.filepath) === p);
  }

  /** An earlier download of this item whose file still exists. */
  async existing(v: Identity): Promise<HistoryEntry | null> {
    const hit = (v.extractor && v.id ? this.findByKey(historyKey(v)) : undefined) ?? this.findByUrl(v.url, v.section);
    if (!hit) return null;
    try {
      await stat(hit.filepath);
      return hit;
    } catch {
      return null; // file was moved or deleted: download again
    }
  }

  async add(e: Omit<HistoryEntry, 'key' | 'finishedAt'>): Promise<void> {
    const entry: HistoryEntry = { ...e, key: historyKey(e), finishedAt: Date.now() };
    const p = samePath(entry.filepath);
    this.entries = [entry, ...this.entries.filter((x) => x.key !== entry.key && samePath(x.filepath) !== p)].slice(0, MAX_ENTRIES);
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entries));
    await rename(tmp, this.file);
  }
}

/** Windows paths are case-insensitive and may use either slash. */
function samePath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}
