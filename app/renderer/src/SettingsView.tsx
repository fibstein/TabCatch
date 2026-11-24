import { useState } from 'react';
import { api, errMsg, type DepStatus, type Settings } from './api';
import { DepProgressList } from './SetupView';

const PRESETS: { value: Settings['preset']; label: string; hint: string }[] = [
  { value: 'compat', label: 'Uyumlu (önerilen)', hint: 'H.264 + AAC, MP4. Her oynatıcıda akıcı oynatma ve sarma.' },
  { value: 'compat1080', label: 'Uyumlu, en fazla 1080p', hint: 'Aynısı, çözünürlük 1080p ile sınırlı.' },
  {
    value: 'best',
    label: 'Maksimum kalite (AV1/VP9)',
    hint: 'MKV. Donanım desteği olmayan bilgisayarlarda ve Windows oynatıcılarında sararken takılabilir.',
  },
  { value: 'audio', label: 'Sadece ses (MP3)', hint: '' },
];

export function SettingsView({
  settings,
  deps,
  onChange,
  onError,
}: {
  settings: Settings;
  deps: DepStatus[];
  onChange: (s: Settings) => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Settings>) => void api().settings.set(patch).then(onChange).catch((e) => onError(errMsg(e)));
  const withBusy = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const updatable = deps.filter((d) => d.updateAvailable).map((d) => d.id);

  return (
    <>
      <section className="card">
        <h2>İndirme</h2>
        <label className="field">
          <span>Klasör</span>
          <div className="row">
            <code className="grow ellipsis">{settings.outputDir}</code>
            <button onClick={() => void api().settings.chooseFolder().then(onChange)}>Değiştir</button>
          </div>
        </label>
        <div className="field">
          <span>Format</span>
          {PRESETS.map((p) => (
            <label key={p.value} className="radio">
              <input type="radio" checked={settings.preset === p.value} onChange={() => set({ preset: p.value })} />
              <span>
                {p.label}
                {p.hint && <div className="muted small">{p.hint}</div>}
              </span>
            </label>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.deepCheck} onChange={(e) => set({ deepCheck: e.target.checked })} />
          <span>
            Derin kontrol
            <div className="muted small">
              Her indirmeden sonra dosyanın tamamını decode ederek bozuk kare arar. Yavaştır ama sorunlu dosyaları kesin yakalar.
            </div>
          </span>
        </label>
      </section>

      <section className="card">
        <h2>Paketler</h2>
        <DepProgressList deps={deps} />
        <label className="check">
          <input type="checkbox" checked={settings.autoUpdateYtDlp} onChange={(e) => set({ autoUpdateYtDlp: e.target.checked })} />
          <span>yt-dlp'yi otomatik güncelle (siteler sık değiştiği için önerilir)</span>
        </label>
        <div className="actions">
          <button disabled={busy} onClick={withBusy(() => api().deps.checkUpdates())}>
            Güncellemeleri kontrol et
          </button>
          <button className="primary" disabled={busy || !updatable.length} onClick={withBusy(() => api().deps.install(updatable))}>
            Güncelle ({updatable.length})
          </button>
          <button disabled={busy} onClick={withBusy(() => api().deps.install(deps.map((d) => d.id)))}>
            Hepsini yeniden kur
          </button>
        </div>
        {settings.lastUpdateCheck > 0 && (
          <p className="muted small">Son kontrol: {new Date(settings.lastUpdateCheck).toLocaleString('tr-TR')}</p>
        )}
      </section>
    </>
  );
}
