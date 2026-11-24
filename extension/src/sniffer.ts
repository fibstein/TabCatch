import { addCandidate, classifyMedia, rankCandidates, type MediaCandidate } from '../../shared/media';

// Video URLs each tab loaded. Kept in session storage because the service worker is stopped
// when idle and would otherwise forget what it saw.
const key = (tabId: number) => `media:${tabId}`;

let writeChain: Promise<void> = Promise.resolve();

function update(tabId: number, fn: (list: MediaCandidate[]) => MediaCandidate[]) {
  // Serialise read-modify-write: a player fires many requests at once.
  writeChain = writeChain.then(async () => {
    const k = key(tabId);
    const cur = ((await chrome.storage.session.get(k))[k] as MediaCandidate[] | undefined) ?? [];
    const next = fn(cur);
    if (next.length) await chrome.storage.session.set({ [k]: next });
    else await chrome.storage.session.remove(k);
  });
}

export async function mediaForTab(tabId: number): Promise<MediaCandidate[]> {
  await writeChain;
  const k = key(tabId);
  return rankCandidates(((await chrome.storage.session.get(k))[k] as MediaCandidate[] | undefined) ?? []);
}

export function startSniffer() {
  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (d.tabId < 0) return undefined;
      const c = classifyMedia(d.url, d.statusCode, d.responseHeaders);
      if (c) update(d.tabId, (list) => addCandidate(list, { ...c, seenAt: Date.now() }));
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );
  // A new page (or a new video in a single-page app) makes the old candidates meaningless.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) update(tabId, () => []);
  });
  chrome.tabs.onRemoved.addListener((tabId) => update(tabId, () => []));
}
