import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  type AppToExt,
  type BrowserName,
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

async function handle(msg: AppToExt) {
  if (msg.type === 'requestTabs') {
    send({ type: 'tabs', requestId: msg.requestId, browser, tabs: await collectTabs() });
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(URL_);
  socket = ws;
  ws.onopen = () => {
    send({ type: 'hello', browser, extensionVersion: chrome.runtime.getManifest().version });
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
