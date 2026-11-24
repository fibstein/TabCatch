import { useState } from 'react';
import { api, errMsg, type QueueItem } from './api';
import { formatBytes } from './SetupView';

const STATUS: Record<QueueItem['status'], string> = {
  queued: 'Sırada',
  downloading: 'İndiriliyor',
  verifying: 'Doğrulanıyor',
  done: 'Tamamlandı',
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
        {(item.status === 'queued' || item.status === 'downloading') && <button onClick={wrap(() => q.cancel(item.id))}>İptal</button>}
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
  if (!items.length) return <p className="muted">Kuyruk boş. "Tablar" sekmesinden video seç.</p>;
  return (
    <ul className="queue">
      {items.map((i) => (
        <Item key={i.id} item={i} onError={onError} />
      ))}
    </ul>
  );
}
