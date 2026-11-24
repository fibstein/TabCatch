// Messages exchanged between the bridge extension and the desktop app over WebSocket.

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 47863;

/** ID derived from the public `key` in extension/manifest.json. Same in Chrome, Edge and Opera. */
export const EXTENSION_ID = 'gmnikljdephmcpmopgefkeggmombghhj';

export type BrowserName = 'chrome' | 'edge' | 'opera' | 'unknown';

export interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl?: string;
}

export type ExtToApp =
  | { type: 'hello'; browser: BrowserName; extensionVersion: string }
  | { type: 'tabs'; requestId: string; browser: BrowserName; tabs: TabInfo[] }
  | { type: 'ping' };

export type AppToExt = { type: 'requestTabs'; requestId: string } | { type: 'pong' };

const BLOCKED_SCHEMES = [
  'chrome:',
  'edge:',
  'opera:',
  'about:',
  'chrome-extension:',
  'extension:',
  'devtools:',
  'view-source:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
];

/** Filters out browser-internal pages; whether yt-dlp supports the URL is checked separately. */
export function isCandidateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (BLOCKED_SCHEMES.includes(parsed.protocol)) return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function parseExtMessage(raw: string): ExtToApp | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'ping':
      return { type: 'ping' };
    case 'hello':
      return {
        type: 'hello',
        browser: asBrowser(m.browser),
        extensionVersion: String(m.extensionVersion ?? ''),
      };
    case 'tabs': {
      if (typeof m.requestId !== 'string' || !Array.isArray(m.tabs)) return null;
      const tabs: TabInfo[] = [];
      for (const t of m.tabs as unknown[]) {
        if (!t || typeof t !== 'object') continue;
        const tab = t as Record<string, unknown>;
        if (typeof tab.url !== 'string') continue;
        tabs.push({
          tabId: Number(tab.tabId) || 0,
          windowId: Number(tab.windowId) || 0,
          url: tab.url,
          title: typeof tab.title === 'string' ? tab.title : tab.url,
          favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : undefined,
        });
      }
      return { type: 'tabs', requestId: m.requestId, browser: asBrowser(m.browser), tabs };
    }
    default:
      return null;
  }
}

function asBrowser(v: unknown): BrowserName {
  return v === 'chrome' || v === 'edge' || v === 'opera' ? v : 'unknown';
}
