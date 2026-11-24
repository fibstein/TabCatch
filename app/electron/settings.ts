import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXTENSION_ID } from '../../shared/protocol';
import type { FormatPreset } from './ytdlp';

export interface Settings {
  outputDir: string;
  preset: FormatPreset;
  /** Full decode after each download; slow, off by default. */
  deepCheck: boolean;
  autoUpdateYtDlp: boolean;
  /** Pass the browser's cookies for the video page to yt-dlp (needed for logged-in content). */
  sendCookies: boolean;
  /** Separate opt-in for YouTube: not needed for public videos, and risky for the account. */
  sendYouTubeCookies: boolean;
  lastUpdateCheck: number;
  /** Extra IDs for development builds loaded without the fixed manifest key. */
  extraExtensionIds: string[];
}

export function defaultSettings(downloadsDir: string): Settings {
  return {
    outputDir: downloadsDir,
    preset: 'compat',
    deepCheck: false,
    autoUpdateYtDlp: true,
    sendCookies: true,
    sendYouTubeCookies: false,
    lastUpdateCheck: 0,
    extraExtensionIds: [],
  };
}

export class SettingsStore {
  private value: Settings;

  constructor(
    private readonly file: string,
    defaults: Settings,
  ) {
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
    } catch {
      /* first run */
    }
    this.value = { ...defaults, ...stored };
  }

  get(): Settings {
    return { ...this.value };
  }

  allowedExtensionIds(): string[] {
    return [EXTENSION_ID, ...this.value.extraExtensionIds];
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    this.value = { ...this.value, ...patch };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.value, null, 2));
    await rename(tmp, this.file);
    return this.get();
  }
}
