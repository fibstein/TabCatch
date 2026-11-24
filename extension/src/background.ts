import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  type AppToExt,
  type BrowserName,
  type CookieInfo,
  type ExtToApp,
  type TabInfo,
} from '../../shared/protocol';

const URL_ = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`;
// Chrome 116+ keeps the service worker alive while WebSocket traffic happens at least every 30 s.
const PING_MS = 20_000;
const RECONNECT_ALARM = 'tabcatch-reconnect';

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | undefined;

function detectBrowser(): BrowserName {
  const brands =
    (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.map(
      (b) => b.brand,
    ) ?? [];
  const ua = navigator.userAgent;
  if (brands.includes('Microsoft Edge') || ua.includes('Edg/')) return 'edge';
  if (brands.includes('Opera') || ua.includes('OPR/')) return 'opera';
  if (brands.includes('Google Chrome') || ua.includes('Chrome/')) return 'chrome';
  return 'unknown';
}

const browser = detectBrowser();

function send(msg: ExtToApp) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function collectTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => typeof t.url === 'string' && t.url.length > 0)
    .map((t) => ({
      tabId: t.id ?? 0,
      windowId: t.windowId,
      url: t.url!,
      title: t.title ?? t.url!,
      favIconUrl: t.favIconUrl,
    }));
}

/** Users can withdraw site access in Edge/Opera; without it cookies.getAll returns nothing. */
function canReadCookies(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ['cookies'], origins: ['<all_urls>'] });
}

async function storeIdForTab(tabId: number | undefined): Promise<string | undefined> {
  if (tabId === undefined) return undefined;
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((s) => s.tabIds.includes(tabId))?.id;
}

/**
 * Only cookies the browser itself would send to this page (plus cookies of its exact host's
 * subdomains), never the whole cookie jar.
 */
async function collectCookies(url: string, tabId?: number): Promise<CookieInfo[]> {
  const storeId = await storeIdForTab(tabId);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const [forUrl, forHost] = await Promise.all([
    chrome.cookies.getAll({ url, storeId }),
    chrome.cookies.getAll({ domain: host, storeId }),
  ]);
  const seen = new Set<string>();
  const out: CookieInfo[] = [];
  for (const c of [...forUrl, ...forHost]) {
    const key = `${c.domain}|${c.path}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.session ? undefined : c.expirationDate,
      name: c.name,
      value: c.value,
    });
  }
  return out;
}

async function handle(msg: AppToExt) {
  if (msg.type === 'requestTabs') {
    send({ type: 'tabs', requestId: msg.requestId, browser, tabs: await collectTabs() });
  } else if (msg.type === 'closeTab') {
    try {
      const tab = await chrome.tabs.get(msg.tabId);
      // The user may have navigated elsewhere in that tab meanwhile; then leave it alone.
      if (tab.url === msg.url) await chrome.tabs.remove(msg.tabId);
    } catch {
      /* tab already closed */
    }
  } else if (msg.type === 'requestCookies') {
    try {
      send({ type: 'cookies', requestId: msg.requestId, cookies: await collectCookies(msg.url, msg.tabId) });
    } catch (err) {
      send({ type: 'cookies', requestId: msg.requestId, cookies: [], error: String(err) });
    }
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(URL_);
  socket = ws;
  ws.onopen = async () => {
    send({ type: 'hello', browser, extensionVersion: chrome.runtime.getManifest().version, canReadCookies: await canReadCookies() });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
  };
  ws.onmessage = (ev) => {
    try {
      void handle(JSON.parse(String(ev.data)) as AppToExt);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (socket === ws) socket = null;
    // App not running (or closed): retry soon; the alarm below also revives a killed worker.
    setTimeout(connect, 5_000);
  };
  ws.onerror = () => ws.close();
}

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
