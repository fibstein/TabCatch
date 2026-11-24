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
          <input type="checkbox" checked={settings.skipDownloaded} onChange={(e) => set({ skipDownloaded: e.target.checked })} />
          <span>
            Daha önce indirilen videoları atla
            <div className="muted small">Dosya hâlâ duruyorsa aynı video tekrar indirilmez. Kuyrukta "Yine de indir" ile geçilebilir.</div>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.closeTabAfterDownload}
            onChange={(e) => set({ closeTabAfterDownload: e.target.checked })}
          />
          <span>
            İndirme bitince tarayıcıdaki tabı kapat
            <div className="muted small">Sadece doğrulamadan geçen videolarda ve tab hâlâ aynı sayfadaysa kapatılır.</div>
          </span>
        </label>
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
        <h2>Dosyaya eklenecekler</h2>
        <label className="check">
          <input type="checkbox" checked={settings.embedMetadata} onChange={(e) => set({ embedMetadata: e.target.checked })} />
          <span>Başlık, kanal, açıklama ve tarih (metadata)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.embedThumbnail} onChange={(e) => set({ embedThumbnail: e.target.checked })} />
          <span>Kapak resmi</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.embedChapters} onChange={(e) => set({ embedChapters: e.target.checked })} />
          <span>Bölüm işaretleri (chapter), varsa</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} />
          <span>
            Altyazılar
            <div className="muted small">Videonun içine gömülür; oynatıcıdan açılıp kapatılabilir. Sadece ses indirmelerinde atlanır.</div>
          </span>
        </label>
        <label className="field">
          <span>Altyazı dilleri</span>
          <input
            type="text"
            defaultValue={settings.subLangs}
            disabled={!settings.subtitles && !settings.autoSubtitles}
            onBlur={(e) => e.target.value !== settings.subLangs && set({ subLangs: e.target.value })}
          />
          <div className="muted small">Virgülle ayrılmış dil kodları. "en.*" İngilizcenin tüm varyantlarını kapsar (en-US, en-GB…).</div>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.autoSubtitles} onChange={(e) => set({ autoSubtitles: e.target.checked })} />
          <span>
            Otomatik oluşturulmuş altyazılar
            <div className="muted small">Konuşma tanımayla üretilenler; kalitesi değişken ve çok dil seçilirse YouTube istekleri sınırlayabilir.</div>
          </span>
        </label>
        <label className="field">
          <span>Hız limiti (MB/sn)</span>
          <input
            type="number"
            min={0}
            step={0.5}
            defaultValue={settings.rateLimitMBps || ''}
            placeholder="sınırsız"
            onBlur={(e) => {
              const v = Math.max(0, Number(e.target.value) || 0);
              if (v !== settings.rateLimitMBps) set({ rateLimitMBps: v });
            }}
          />
          <div className="muted small">Boş bırakırsan sınırsız. Yeni başlayan indirmelere uygulanır.</div>
        </label>
      </section>

      <section className="card">
        <h2>Uygulama</h2>
        <label className="check">
          <input type="checkbox" checked={settings.notifications} onChange={(e) => set({ notifications: e.target.checked })} />
          <span>Kuyruk bitince bildirim göster</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => set({ minimizeToTray: e.target.checked })} />
          <span>
            Pencere kapatılınca sistem tepsisinde çalışmaya devam et
            <div className="muted small">İndirmeler arka planda sürer; tamamen kapatmak için tepsi ikonunda "Çıkış".</div>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.startAtLogin} onChange={(e) => set({ startAtLogin: e.target.checked })} />
          <span>Windows açılışında başlat (pencere açılmadan, tepside)</span>
        </label>
      </section>

      <section className="card">
        <h2>Giriş gerektiren videolar</h2>
        <label className="check">
          <input type="checkbox" checked={settings.sendCookies} onChange={(e) => set({ sendCookies: e.target.checked })} />
          <span>
            Tarayıcıdaki oturumu kullan (cookie gönder)
            <div className="muted small">
              Her video indirilmeden hemen önce, videonun açık olduğu tarayıcıdan yalnızca o sayfaya ait cookie'ler alınır, geçici bir
              dosyayla yt-dlp'ye verilir ve indirme bitince silinir. Cookie'ler yalnızca o videonun sitesine gönderilir, loglara
              yazılmaz.
            </div>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!settings.sendCookies}
            checked={settings.sendYouTubeCookies}
            onChange={(e) => set({ sendYouTubeCookies: e.target.checked })}
          />
          <span>
            YouTube için de gönder
            <div className="muted small">
              Sadece yaş sınırlı, üyelere özel veya Premium videolar için gerekir. yt-dlp, giriş yapılmış hesapla yoğun indirmenin
              hesabın geçici veya kalıcı olarak kısıtlanmasına yol açabileceği konusunda uyarıyor. Mümkünse ayrı bir hesap kullan.
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
