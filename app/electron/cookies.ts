import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isYouTubeUrl, toNetscapeCookies, type CookieInfo } from '../../shared/protocol';
import type { BridgeClient } from './bridge';

export interface CookieSettings {
  sendCookies: boolean;
  sendYouTubeCookies: boolean;
}

export type CookieDecision = { send: true } | { send: false; note?: string };

export function cookieDecision(url: string, s: CookieSettings): CookieDecision {
  if (!s.sendCookies) return { send: false };
  // Public YouTube videos don't need cookies, and yt-dlp warns that logged-in use can get the
  // account restricted; so YouTube is opt-in separately.
  if (isYouTubeUrl(url) && !s.sendYouTubeCookies) return { send: false, note: 'YouTube için cookie gönderilmedi (Ayarlar)' };
  return { send: true };
}

/**
 * The extension gets a new connection id whenever its service worker restarts, so fall back to
 * another connection of the same browser when the original one is gone.
 */
export function pickCookieClient(clients: BridgeClient[], item: { clientId?: string; browser?: string }): BridgeClient | undefined {
  const exact = clients.find((c) => c.id === item.clientId);
  if (exact) return exact;
  return clients.find((c) => c.browser === item.browser && c.canReadCookies) ?? clients.find((c) => c.browser === item.browser);
}

export function cookieFilePath(dir: string, itemId: string): string {
  return join(dir, `${itemId}.txt`);
}

export async function writeCookieFile(dir: string, itemId: string, cookies: CookieInfo[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = cookieFilePath(dir, itemId);
  await writeFile(file, toNetscapeCookies(cookies), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return file;
}

export function deleteCookieFile(dir: string, itemId: string): Promise<void> {
  return rm(cookieFilePath(dir, itemId), { force: true });
}
