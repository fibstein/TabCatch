import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type BrowserTabs } from './api';

const BROWSER_LABEL: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera', unknown: 'Tarayıcı' };

export function TabsView({ onQueued, onError }: { onQueued: () => void; onError: (m: string) => void }) {
  const [groups, setGroups] = useState<BrowserTabs[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const key = (g: BrowserTabs, tabId: number) => `${g.clientId}:${tabId}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await api().tabs.refresh());
      setSelected(new Set());
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const allKeys = groups.flatMap((g) => g.tabs.map((t) => key(g, t.tabId)));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const enqueue = async () => {
    // Keep tab order (window by window, left to right): that is the download order.
    const entries = groups.flatMap((g) =>
      g.tabs
        .filter((t) => selected.has(key(g, t.tabId)))
        // clientId + tabId let the app fetch this tab's cookies from the right browser later.
        .map((t) => ({ url: t.url, title: t.title, browser: g.browser, clientId: g.clientId, tabId: t.tabId })),
    );
    try {
      await api().queue.add(entries);
      onQueued();
    } catch (e) {
      onError(errMsg(e));
    }
  };

  return (
    <section>
      <div className="toolbar">
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Yenileniyor…' : 'Tabları yenile'}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(allKeys))}
          />
          Tümünü seç
        </label>
        <span className="spacer" />
        <button className="primary" disabled={!selected.size} onClick={() => void enqueue()}>
          Seçilenleri indir ({selected.size})
        </button>
      </div>

      {groups.length === 0 && !loading && <p className="muted">Tab bulunamadı.</p>}
      {groups.map((g) => (
        <div key={g.clientId} className="card">
          <h3>
            {BROWSER_LABEL[g.browser]} <span className="muted small">({g.tabs.length} tab)</span>
          </h3>
          <ul className="tabs">
            {g.tabs.map((t) => {
              const k = key(g, t.tabId);
              return (
                <li key={k} onClick={() => toggle(k)} className={selected.has(k) ? 'selected' : ''}>
                  <input type="checkbox" checked={selected.has(k)} readOnly />
                  {t.favIconUrl?.startsWith('http') ? <img src={t.favIconUrl} alt="" /> : <span className="favicon" />}
                  <div className="tab-text">
                    <div className="ellipsis">{t.title}</div>
                    <div className="muted small ellipsis">{t.url}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
