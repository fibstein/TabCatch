import { useEffect, useState } from 'react';
import { api, errMsg, type QueueItem } from './api';
import { formatBytes } from './SetupView';
import { formatDuration } from './TabsView';

const STATUS: Record<QueueItem['status'], string> = {
  queued: 'Sırada',
  downloading: 'İndiriliyor',
  verifying: 'Doğrulanıyor',
  paused: 'Duraklatıldı',
  done: 'Tamamlandı',
  skipped: 'Daha önce indirildi',
  verify_failed: 'Dosya sorunlu',
  error: 'Hata',
  canceled: 'İptal edildi',
};

function eta(s: number | null): string {
  if (s === null) return '';
  const m = Math.floor(s / 60);
  return m ? `${m} dk ${Math.round(s % 60)} sn` : `${Math.round(s)} sn`;
}

function Item({ item, onError }: { item: QueueItem; onError: (m: string) => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [sectionText, setSectionText] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const p = item.progress;
  const q = api().queue;
  const wrap = (fn: () => Promise<unknown>) => () => void fn().catch((e) => onError(errMsg(e)));

  const repair = (mode: 'remux' | 'reencode') =>
    wrap(async () => {
      if (mode === 'reencode' && !confirm('Yeniden encode uzun sürebilir (video süresine yakın). Devam edilsin mi?')) return;
      setRepairing(true);
      try {
        const v = await q.repair(item.id, mode);
        if (!v.ok) onError(`Onarım sorunu çözmedi: ${v.problems.join('; ')}`);
      } finally {
        setRepairing(false);
      }
    });

  return (
    <li className={`queue-item ${item.status}`}>
      <div className="row">
        <div className="grow">
          <div className="ellipsis">
            <strong>{item.result?.title ?? item.title}</strong>
          </div>
          <div className="muted small ellipsis">{item.url}</div>
        </div>
        <span className={`badge ${item.status}`}>{STATUS[item.status]}</span>
      </div>

      {item.status === 'downloading' && (
        <div className="row small">
          <progress max={100} value={p?.percent ?? undefined} />
          <span className="mono">
            {p?.percent != null ? `${p.percent.toFixed(1)}%` : '…'}
            {p?.speed ? ` · ${formatBytes(p.speed)}/s` : ''}
            {p?.eta != null ? ` · ${eta(p.eta)}` : ''}
            {p?.fragmentCount ? ` · parça ${p.fragmentIndex}/${p.fragmentCount}` : ''}
          </span>
        </div>
      )}

      {item.section && sectionText === null && (
        <div className="small">
          Bölüm: {formatDuration(item.section.start) || '0:00'} – {formatDuration(item.section.end)}
        </div>
      )}
      {sectionText !== null && (
        <div className="row small">
          <input
            className="section-input"
            placeholder="10:00-15:30"
            value={sectionText}
            autoFocus
            onChange={(e) => setSectionText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <button
            className="small"
            onClick={wrap(async () => {
              await q.setSection(item.id, sectionText);
              setSectionText(null);
            })}
          >
            Kaydet
          </button>
          <button className="small" onClick={() => setSectionText(null)}>
            Vazgeç
          </button>
          <span className="muted">Boş bırakırsan videonun tamamı iner. Kesim noktaları yeniden encode edildiği için biraz yavaştır.</span>
        </div>
      )}
      {item.cookieNote && <div className="small muted">{item.cookieNote}</div>}
      {item.verify && (
        <div className="small muted mono">
          {[item.verify.videoCodec, item.verify.audioCodec].filter(Boolean).join(' + ')}
          {item.verify.actualDuration ? ` · ${item.verify.actualDuration.toFixed(0)} sn` : ''}
          {item.verifyRetries ? ` · ${item.verifyRetries} kez otomatik yeniden indirildi` : ''}
        </div>
      )}
      {item.error && <div className="small error-text">{item.error}</div>}
      {item.status === 'verify_failed' && item.verify?.problems.some((p) => p.includes('boşluk')) && (
        <div className="small muted">
          Dosyada eksik parça var. Eksik veri onarımla geri gelmez; "Yeniden indir" ile sıfırdan indir. Sorun sürerse kaynak site
          o parçayı vermiyor demektir.
        </div>
      )}

      <div className="actions small">
        {(item.status === 'queued' || item.status === 'downloading') && <button onClick={wrap(() => q.pause(item.id))}>Duraklat</button>}
        {item.status === 'paused' && <button onClick={wrap(() => q.resume(item.id))}>Devam et</button>}
        {['queued', 'paused', 'error', 'canceled', 'skipped'].includes(item.status) && sectionText === null && (
          <button
            onClick={() =>
              setSectionText(item.section ? `${formatDuration(item.section.start) || '0:00'}-${formatDuration(item.section.end)}` : '')
            }
          >
            {item.section ? 'Bölümü değiştir' : 'Sadece bir bölüm'}
          </button>
        )}
        {item.status === 'skipped' && <button onClick={wrap(() => q.force(item.id))}>Yine de indir</button>}
        {(item.status === 'queued' || item.status === 'downloading' || item.status === 'paused') && (
          <button onClick={wrap(() => q.cancel(item.id))}>İptal</button>
        )}
        {['error', 'canceled', 'verify_failed'].includes(item.status) && (
          <button onClick={wrap(() => q.retry(item.id))}>Yeniden indir</button>
        )}
        {(item.status === 'verify_failed' || item.status === 'done') && item.result && (
          <>
            <button disabled={repairing} onClick={repair('remux')} title="Kayıpsız yeniden paketleme: hızlı, index/konteyner sorunlarını giderir">
              Onar (hızlı)
            </button>
            <button disabled={repairing} onClick={repair('reencode')} title="H.264 + AAC olarak yeniden encode: yavaş, sarma sorunlarını kesin çözer">
              Onar (yeniden encode)
            </button>
          </>
        )}
        {item.result && <button onClick={wrap(() => q.show(item.id))}>Klasörde göster</button>}
        <button onClick={wrap(async () => setLog(log === null ? await q.log(item.id) : null))}>{log === null ? 'Log' : 'Logu gizle'}</button>
        {!['downloading', 'verifying'].includes(item.status) && <button onClick={wrap(() => q.remove(item.id))}>Kaldır</button>}
      </div>
      {log !== null && <pre className="log">{log || '(boş)'}</pre>}
    </li>
  );
}

export function QueueView({ items, onError }: { items: QueueItem[]; onError: (m: string) => void }) {
  const [paused, setPaused] = useState(false);
  // Re-read after every queue change: pausing is also triggered from the main process.
  useEffect(() => {
    void api().queue.isPaused().then(setPaused);
  }, [items]);

  if (!items.length) return <p className="muted">Kuyruk boş. "Tablar" sekmesinden video seç.</p>;
  const finished = items.filter((i) => ['done', 'skipped', 'canceled'].includes(i.status));
  const toggle = () =>
    void api()
      .queue.setPaused(!paused)
      .then(() => setPaused(!paused))
      .catch((e) => onError(errMsg(e)));
  return (
    <>
      <div className="toolbar">
        <button className={paused ? 'primary' : ''} onClick={toggle}>
          {paused ? 'Kuyruğu sürdür' : 'Kuyruğu duraklat'}
        </button>
        {paused && <span className="muted small">Duraklatıldı. Yarım kalan indirme kaldığı yerden devam edecek.</span>}
        <span className="spacer" />
        {finished.length > 0 && (
          <button onClick={() => void Promise.all(finished.map((i) => api().queue.remove(i.id))).catch((e) => onError(errMsg(e)))}>
            Bitenleri temizle ({finished.length})
          </button>
        )}
      </div>
      <ul className="queue">
        {items.map((i) => (
          <Item key={i.id} item={i} onError={onError} />
        ))}
      </ul>
    </>
  );
}
