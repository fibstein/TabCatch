import { useEffect, useState } from 'react';
import { api, errMsg, type DepId, type DepStatus, type InstallProgress } from './api';

type Progress = InstallProgress & { error?: string };

const PHASE: Record<InstallProgress['phase'], string> = {
  checksum: 'Checksum alınıyor',
  download: 'İndiriliyor',
  extract: 'Arşivden çıkarılıyor',
  done: 'Tamam',
};

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function DepProgressList({ deps }: { deps: DepStatus[] }) {
  const [progress, setProgress] = useState<Partial<Record<DepId, Progress>>>({});
  useEffect(() => api().on('deps:progress', (p) => setProgress((prev) => ({ ...prev, [p.depId]: p }))), []);

  return (
    <table className="deps">
      <tbody>
        {deps.map((d) => {
          const p = progress[d.id];
          const pct = p?.phase === 'download' && p.total ? (p.received / p.total) * 100 : null;
          return (
            <tr key={d.id}>
              <td>
                <strong>{d.label}</strong>
                <div className="muted small">{d.reason}</div>
              </td>
              <td className={`state ${d.state}`}>
                {d.state === 'ok' ? 'Kurulu' : d.state === 'missing' ? 'Eksik' : 'Bozuk'}
                {d.updateAvailable ? ' · güncelleme var' : ''}
                {d.version && <div className="muted small mono">{d.version.slice(0, 40)}</div>}
              </td>
              <td className="progress-cell">
                {p && p.phase !== 'done' && (
                  <>
                    <div className="small">
                      {PHASE[p.phase]}
                      {p.attempt > 1 ? ` (deneme ${p.attempt})` : ''}
                      {p.phase === 'download' && ` · ${formatBytes(p.received)} / ${formatBytes(p.total)}`}
                    </div>
                    {pct !== null && <progress max={100} value={pct} />}
                  </>
                )}
                {p?.error && <div className="small error-text">{p.error}</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SetupView({ deps, onError }: { deps: DepStatus[]; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const missing = deps.filter((d) => d.state !== 'ok');

  const run = async () => {
    setBusy(true);
    try {
      await api().deps.install(missing.map((d) => d.id));
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Gerekli paketler</h2>
      <p className="muted">
        TabCatch indirme için aşağıdaki programları kullanır. Resmi GitHub sürümlerinden indirilir, SHA-256 ile
        doğrulanır ve yalnızca bu kullanıcının uygulama klasörüne kurulur (yönetici yetkisi gerekmez).
      </p>
      <DepProgressList deps={deps} />
      <div className="actions">
        <button className="primary" disabled={busy} onClick={run}>
          {busy ? 'Kuruluyor…' : `Eksikleri kur (${missing.length})`}
        </button>
        <button disabled={busy} onClick={() => void api().deps.status()}>
          Tekrar kontrol et
        </button>
      </div>
    </section>
  );
}
