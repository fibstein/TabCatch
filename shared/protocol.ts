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

/** Subset of chrome.cookies.Cookie needed for a Netscape cookies.txt file. */
export interface CookieInfo {
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; absent for session cookies. */
  expirationDate?: number;
  name: string;
  value: string;
}

export type ExtToApp =
  | { type: 'hello'; browser: BrowserName; extensionVersion: string; canReadCookies: boolean }
  | { type: 'tabs'; requestId: string; browser: BrowserName; tabs: TabInfo[] }
  | { type: 'cookies'; requestId: string; cookies: CookieInfo[]; error?: string }
  /** "TabCatch'e gönder" from the context menu or toolbar button. */
  | { type: 'enqueue'; requestId: string; browser: BrowserName; items: { url: string; title: string; tabId?: number }[] }
  | { type: 'ping' };

export type AppToExt =
  | { type: 'requestTabs'; requestId: string }
  /** Cookies the browser would send to `url`, from the cookie store of `tabId` when given. */
  | { type: 'requestCookies'; requestId: string; url: string; tabId?: number }
  /** Close the tab after its video was downloaded, only if it still shows `url`. */
  | { type: 'closeTab'; tabId: number; url: string }
  | { type: 'enqueueResult'; requestId: string; ok: boolean; message: string }
  | { type: 'pong' };

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
        canReadCookies: m.canReadCookies === true,
      };
    case 'cookies': {
      if (typeof m.requestId !== 'string' || !Array.isArray(m.cookies)) return null;
      const cookies: CookieInfo[] = [];
      for (const c of m.cookies as unknown[]) {
        if (!c || typeof c !== 'object') continue;
        const k = c as Record<string, unknown>;
        if (typeof k.domain !== 'string' || typeof k.name !== 'string' || typeof k.value !== 'string') continue;
        cookies.push({
          domain: k.domain,
          hostOnly: k.hostOnly === true,
          path: typeof k.path === 'string' ? k.path : '/',
          secure: k.secure === true,
          httpOnly: k.httpOnly === true,
          expirationDate: typeof k.expirationDate === 'number' ? k.expirationDate : undefined,
          name: k.name,
          value: k.value,
        });
      }
      return { type: 'cookies', requestId: m.requestId, cookies, error: typeof m.error === 'string' ? m.error : undefined };
    }
    case 'enqueue': {
      if (typeof m.requestId !== 'string' || !Array.isArray(m.items)) return null;
      const items: { url: string; title: string; tabId?: number }[] = [];
      for (const it of m.items as unknown[]) {
        if (!it || typeof it !== 'object') continue;
        const r = it as Record<string, unknown>;
        if (typeof r.url !== 'string') continue;
        items.push({ url: r.url, title: typeof r.title === 'string' ? r.title : r.url, tabId: typeof r.tabId === 'number' ? r.tabId : undefined });
      }
      return { type: 'enqueue', requestId: m.requestId, browser: asBrowser(m.browser), items };
    }
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

/** Netscape cookies.txt, the format yt-dlp's --cookies reads. */
export function toNetscapeCookies(cookies: CookieInfo[]): string {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by TabCatch for a single download; deleted afterwards.', ''];
  for (const c of cookies) {
    // Fields are tab separated; a tab or newline in any field would corrupt the file.
    if ([c.domain, c.path, c.name, c.value].some((f) => /[\t\r\n]/.test(f))) continue;
    if (!c.domain) continue;
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    lines.push(
      [
        c.httpOnly ? `#HttpOnly_${domain}` : domain,
        c.hostOnly ? 'FALSE' : 'TRUE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(c.expirationDate ? Math.floor(c.expirationDate) : 0),
        c.name,
        c.value,
      ].join('\t'),
    );
  }
  return lines.join('\n') + '\n';
}

const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

export function isYouTubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return YOUTUBE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
