import { useEffect, useState } from 'react';
import { api, errMsg, type BridgeClient, type DepStatus, type QueueItem, type Settings } from './api';
import { SetupView } from './SetupView';
import { TabsView } from './TabsView';
import { QueueView } from './QueueView';
import { SettingsView } from './SettingsView';
import { ExtensionGuide } from './ExtensionGuide';

type Page = 'tabs' | 'queue' | 'settings';

export function App() {
  const [deps, setDeps] = useState<DepStatus[] | null>(null);
  const [clients, setClients] = useState<BridgeClient[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<Page>('tabs');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const a = api();
    void a.deps.status().then(setDeps).catch((e) => setError(errMsg(e)));
    void a.bridge.clients().then(setClients);
    void a.queue.list().then(setQueue);
    void a.settings.get().then(setSettings);
    const offs = [
      a.on('deps:status', setDeps),
      a.on('bridge:clients', setClients),
      a.on('queue:update', setQueue),
      a.on('app:error', setError),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (!deps || !settings) return <div className="center muted">Yükleniyor…</div>;

  const ready = deps.every((d) => d.state === 'ok');
  const updates = deps.filter((d) => d.updateAvailable);
  const active = queue.filter((q) => q.status === 'queued' || q.status === 'downloading' || q.status === 'verifying').length;

  return (
    <div className="app">
      <header>
        <strong className="brand">TabCatch</strong>
        <nav>
          <button className={page === 'tabs' ? 'active' : ''} onClick={() => setPage('tabs')}>
            Tablar
          </button>
          <button className={page === 'queue' ? 'active' : ''} onClick={() => setPage('queue')}>
            Kuyruk{active ? ` (${active})` : ''}
          </button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            Ayarlar{updates.length ? ' •' : ''}
          </button>
        </nav>
        <span className="muted small">
          {clients.length
            ? `Bağlı: ${clients.map((c) => (c.canReadCookies ? c.browser : `${c.browser} (cookie izni yok)`)).join(', ')}`
            : 'Tarayıcı eklentisi bağlı değil'}
        </span>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="muted">(kapat)</span>
        </div>
      )}

      <main>
        {!ready ? (
          <SetupView deps={deps} onError={setError} />
        ) : page === 'tabs' ? (
          clients.length ? (
            <TabsView onQueued={() => setPage('queue')} onError={setError} />
          ) : (
            <ExtensionGuide />
          )
        ) : page === 'queue' ? (
          <QueueView items={queue} onError={setError} />
        ) : (
          <SettingsView settings={settings} deps={deps} onChange={setSettings} onError={setError} />
        )}
      </main>
    </div>
  );
}
