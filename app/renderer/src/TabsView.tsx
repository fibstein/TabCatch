import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type BrowserTabs, type NewItem, type ProbeResult } from './api';
import { formatBytes } from './SetupView';

const BROWSER_LABEL: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera', unknown: 'Tarayıcı' };

type ProbeState = ProbeResult | 'loading';

export function formatDuration(s?: number): string {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function ProbeInfo({ p }: { p?: ProbeState }) {
  if (!p) return null;
  if (p === 'loading') return <div className="small muted">Kontrol ediliyor…</div>;
  if (!p.supported) return <div className="small muted">Desteklenmiyor: {p.error}</div>;
  if (p.isPlaylist) return <div className="small">Playlist · {p.entryCount ?? '?'} video</div>;
  const parts = [
    formatDuration(p.duration),
    p.maxHeight ? `${p.maxHeight}p` : '',
    p.filesize ? `~${formatBytes(p.filesize)}` : '',
    p.isLive ? 'CANLI' : '',
    p.extractor?.toLowerCase(),
  ].filter(Boolean);
  return (
    <div className="small">
      <span className="muted">{parts.join(' · ')}</span>
      {p.alreadyDownloaded && <span className="tag">Daha önce indirildi</span>}
    </div>
  );
}

/** A tab can be ticked when it isn't a whole playlist; "select all" also skips doubtful ones. */
const selectable = (p?: ProbeState) => !(p && p !== 'loading' && p.isPlaylist);
const goodForSelectAll = (p?: ProbeState) => p !== undefined && p !== 'loading' && p.supported && !p.isPlaylist && !p.alreadyDownloaded;

export function TabsView({ onQueued, onError }: { onQueued: () => void; onError: (m: string) => void }) {
  const [groups, setGroups] = useState<BrowserTabs[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [playlists, setPlaylists] = useState<Record<string, ProbeState>>({});
  const [loading, setLoading] = useState(false);

  const key = (g: BrowserTabs, tabId: number) => `${g.clientId}:${tabId}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const gs = await api().tabs.refresh();
      setGroups(gs);
      setSelected(new Set());
      setPlaylists({});
      const initial: Record<string, ProbeState> = {};
      for (const g of gs) for (const t of g.tabs) initial[key(g, t.tabId)] = 'loading';
      setProbes(initial);
      // The main process runs at most two yt-dlp checks at a time; results stream in.
      for (const g of gs) {
        for (const t of g.tabs) {
          const k = key(g, t.tabId);
          void api()
            .tabs.probe(t.url, { clientId: g.clientId, tabId: t.tabId, browser: g.browser })
            .then((r) => setProbes((prev) => ({ ...prev, [k]: r })))
            .catch((e) => setProbes((prev) => ({ ...prev, [k]: { url: t.url, supported: false, isPlaylist: false, hasPlaylist: false, error: errMsg(e) } })));
        }
      }
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

  const openPlaylist = async (g: BrowserTabs, tabId: number, url: string) => {
    const k = key(g, tabId);
    setPlaylists((prev) => ({ ...prev, [k]: 'loading' }));
    try {
      const r = await api().tabs.playlist(url, { clientId: g.clientId, tabId, browser: g.browser });
      setPlaylists((prev) => ({ ...prev, [k]: r }));
      if (!r.supported) onError(r.error ?? 'Playlist açılamadı');
    } catch (e) {
      setPlaylists((prev) => ({ ...prev, [k]: { url, supported: false, isPlaylist: false, hasPlaylist: false, error: errMsg(e) } }));
    }
  };

  const allKeys = groups.flatMap((g) => g.tabs.map((t) => key(g, t.tabId)).filter((k) => goodForSelectAll(probes[k])));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const enqueue = async () => {
    // Tab order (window by window, left to right) is the download order; playlist videos follow their tab.
    const entries: NewItem[] = [];
    for (const g of groups) {
      for (const t of g.tabs) {
        const k = key(g, t.tabId);
        const p = probes[k];
        const info = p && p !== 'loading' && p.supported ? p : undefined;
        if (selected.has(k)) {
          entries.push({ url: t.url, title: info?.title ?? t.title, browser: g.browser, clientId: g.clientId, tabId: t.tabId, extractor: info?.extractor, videoId: info?.id });
        }
        const pl = playlists[k];
        if (pl && pl !== 'loading') {
          for (const e of pl.entries ?? []) {
            // No tabId: finishing one playlist video must not close the playlist tab.
            if (selected.has(`${k}#${e.url}`)) entries.push({ url: e.url, title: e.title, browser: g.browser, clientId: g.clientId, videoId: e.id });
          }
        }
      }
    }
    try {
      const r = await api().queue.add(entries);
      if (r.playlists.length) onError(`Playlist olduğu için eklenmedi, "Playlist'i aç" ile videoları seç: ${r.playlists.join(', ')}`);
      if (r.added) onQueued();
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
        <label className="check" title="Desteklenen ve daha önce indirilmemiş videoları seçer">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(allKeys))} />
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
              const p = probes[k];
              const pl = playlists[k];
              const canSelect = selectable(p);
              const showPlaylistBtn = p && p !== 'loading' && (p.isPlaylist || p.hasPlaylist) && !pl;
              return (
                <li key={k} className="tab-block">
                  <div
                    className={`tab-row ${selected.has(k) ? 'selected' : ''} ${canSelect ? '' : 'disabled'}`}
                    onClick={() => canSelect && toggle(k)}
                  >
                    <input type="checkbox" checked={selected.has(k)} disabled={!canSelect} readOnly />
                    {t.favIconUrl?.startsWith('http') ? <img src={t.favIconUrl} alt="" /> : <span className="favicon" />}
                    <div className="tab-text">
                      <div className="ellipsis">{t.title}</div>
                      <div className="muted small ellipsis">{t.url}</div>
                      <ProbeInfo p={p} />
                    </div>
                    {showPlaylistBtn && (
                      <button
                        className="small"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void openPlaylist(g, t.tabId, t.url);
                        }}
                      >
                        Playlist'i aç
                      </button>
                    )}
                  </div>
                  {pl === 'loading' && <div className="playlist muted small">Playlist yükleniyor…</div>}
                  {pl && pl !== 'loading' && pl.entries && (
                    <div className="playlist">
                      <div className="row small">
                        <strong className="grow">
                          {pl.title ?? 'Playlist'} · {pl.entries.length} video
                          {pl.entryCount && pl.entryCount > pl.entries.length ? ` (ilk ${pl.entries.length} gösteriliyor)` : ''}
                        </strong>
                        <button
                          className="small"
                          onClick={() =>
                            setSelected((prev) => {
                              const ks = pl.entries!.map((e) => `${k}#${e.url}`);
                              const all = ks.every((x) => prev.has(x));
                              const next = new Set(prev);
                              ks.forEach((x) => (all ? next.delete(x) : next.add(x)));
                              return next;
                            })
                          }
                        >
                          Hepsini seç / kaldır
                        </button>
                      </div>
                      <ul className="tabs">
                        {pl.entries.map((e, i) => {
                          const ek = `${k}#${e.url}`;
                          return (
                            <li key={ek} className={`tab-row ${selected.has(ek) ? 'selected' : ''}`} onClick={() => toggle(ek)}>
                              <input type="checkbox" checked={selected.has(ek)} readOnly />
                              <span className="muted small mono">{i + 1}.</span>
                              <div className="tab-text">
                                <div className="ellipsis">{e.title}</div>
                                {e.duration ? <div className="muted small">{formatDuration(e.duration)}</div> : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
