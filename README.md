# TabCatch

Chrome, Edge ve Opera'da açık olan tablardaki videoları [yt-dlp](https://github.com/yt-dlp/yt-dlp) ile sırayla indiren Windows uygulaması.

## Nasıl çalışır

```
[Tarayıcı eklentisi] --WebSocket 127.0.0.1:47863--> [TabCatch (Electron)] --> yt-dlp.exe / ffmpeg.exe / deno.exe
  açık tab listesi                                    kuyruk, doğrulama, onarım
```

- **Neden eklenti var?** Tarayıcılar açık tabların listesini dışarıdaki programlara vermiyor. Chrome 136'dan beri `--remote-debugging-port` normal profilde de çalışmıyor. Eklentinin tek görevi tab listesini uygulamaya göndermek.
- **Giriş gerektiren videolar:** Bir video indirilmeden hemen önce uygulama, videonun açık olduğu tarayıcıdaki eklentiden o sayfaya gönderilecek cookie'leri ister. Bunlar `cookies.txt` formatında geçici bir dosyaya yazılır, `--cookies` ile yt-dlp'ye verilir ve yt-dlp kapanınca silinir. Tarayıcının bütün cookie'leri alınmaz; sadece o URL'ye gidecek olanlar ve o host'un alt alan adlarına ait olanlar alınır. Sekme gizli pencerede ya da farklı bir cookie store'daysa o store kullanılır.
- **Güvenlik:** Uygulama yalnızca `127.0.0.1`'i dinliyor ve sadece `chrome-extension://gmnikljdephmcpmopgefkeggmombghhj` origin'inden gelen bağlantıları kabul ediyor. Web sayfaları bu origin'i taklit edemez. Eklenti ID'si `extension/manifest.json` içindeki `key` alanıyla sabitlendiği için Chrome, Edge ve Opera'da aynı.

## Özellikler

- **Tablardan indirme:** Tablar sekmesi açık tabları tarayıcıya göre listeler. Her tab için yt-dlp ile ön kontrol yapılır: süre, çözünürlük, tahmini boyut, "desteklenmiyor" veya "daha önce indirildi" bilgisi. Aynı anda en fazla 2 kontrol çalışır, sonuçlar 10 dakika önbellekte tutulur.
- **Playlist:** Bütün bir playlist tek öğe olarak kuyruğa eklenemez (yt-dlp hepsini tek öğe altında indirirdi). "Playlist'i aç" en fazla 500 videoyu listeler, istenenler seçilir.
- **Tarayıcıdan gönderme:** Sağ tık → "TabCatch'e gönder" (sayfa, link veya video üzerinde) ya da araç çubuğundaki TabCatch butonu. Sonuç eklenti ikonunda ✓ / ! olarak görünür.
- **Ağdan video yakalama:** yt-dlp'nin tanımadığı sitelerde eklenti, sayfanın yüklediği HLS/DASH manifest'lerini ve büyük video dosyalarını yakalar. Parçalar, küçük önizlemeler ve YouTube trafiği elenir. Yakalanan akış, sayfanın `Referer`/`Origin` header'ları, sayfa ve akış cookie'leri ile indirilir; dosya adı tab başlığından gelir.
- **Kuyruk:** Sıralı indirme; öğe bazında veya bütün kuyruk için duraklat/devam (yarım dosya korunur, kalan parçalardan devam edilir), iptal, yeniden indir. Kuyruk `%APPDATA%\TabCatch\queue.json` dosyasına kaydedilir; uygulama kapanıp açılınca yarım kalan indirme kaldığı yerden sürer.
- **Geçmiş:** Biten indirmeler `history.json` dosyasına yazılır. Dosyası hâlâ duran bir video tekrar eklenirse atlanır ("Yine de indir" ile geçilebilir). Kayıt anahtarı `extractor:id`; yt-dlp'nin generic extractor'ında ID'ler çakıştığı için (`index` gibi) orada URL kullanılır. Aynı dosya adına düşen iki farklı video `… (2).mp4` olarak kaydedilir.
- **Bölüm indirme:** Sıradaki bir öğede "Sadece bir bölüm" → `10:00-15:30`. Kesim noktaları birebir olsun diye kesim yerleri yeniden encode edilir; dosya adına `[10m00s-15m30s]` eklenir.
- **Dosyaya gömülenler:** Metadata, kapak resmi (JPEG'e çevrilerek), bölüm işaretleri ve altyazılar (varsayılan diller `tr,en.*`). Otomatik altyazılar isteğe bağlı.
- **Diğer:** Hız limiti, kuyruk bitince Windows bildirimi, sistem tepsisinde çalışma (pencereyi kapatmak indirmeleri durdurmaz, "Çıkış" tepsi menüsünde), Windows açılışında başlatma, indirme sonrası tabı kapatma (tab hâlâ aynı sayfadaysa).

## Gerekli paketler: otomatik

İlk açılışta uygulama eksik paketleri GitHub release'lerinden `%LOCALAPPDATA%\TabCatch\bin` klasörüne kurar. Yönetici yetkisi gerekmez.

| Paket | Neden |
|---|---|
| yt-dlp.exe | indirici |
| ffmpeg.exe, ffprobe.exe (yt-dlp/FFmpeg-Builds) | ses+görüntü birleştirme, doğrulama, onarım |
| deno.exe | yt-dlp'nin YouTube'un JS korumalarını çözmek için önerdiği runtime |

- Her dosya, release'te yayınlanan SHA-256 ile doğrulanmadan kurulmaz.
- Zip'ten sadece gereken exe'ler çıkarılır; `../` içeren arşivler reddedilir.
- Güncelleme kontrolü günde bir kez yapılır: kurulumda kaydedilen SHA-256, en son release'inkiyle karşılaştırılır. yt-dlp otomatik güncellenir; ffmpeg ve Deno için Ayarlar'da buton var. Kuyruk çalışırken güncelleme yapılmaz.

## Bozuk dosya / sararken takılma önlemleri

| Neden | Önlem |
|---|---|
| yt-dlp varsayılan olarak alınamayan HLS/DASH parçalarını **atlıyor** ve yine "başarılı" diyor | `--abort-on-unavailable-fragments --fragment-retries 20` |
| Eksik parça dosya süresini değiştirmiyor (zaman damgaları boşluktan sonra devam ediyor) | ffprobe ile paket zaman damgalarında boşluk/geri sıçrama aranıyor |
| ffmpeg olmadan HLS ham olarak birleştiriliyor | ffmpeg kurulmadan indirme başlamıyor |
| AV1/VP9 Windows oynatıcılarında sararken zorlanıyor | Varsayılan format H.264 + AAC (MP4) |
| Index (moov) dosyanın sonunda | `-movflags +faststart` |

Doğrulama başarısız olursa dosya silinir ve bir kez sıfırdan (`--no-continue`) tekrar indirilir. Yine başarısız olursa öğe "Dosya sorunlu" olarak işaretlenir. O zaman iki onarım seçeneği var: **Onar (hızlı)** kayıpsız remux yapar; **Onar (yeniden encode)** dosyayı H.264/AAC'ye çevirir ve sık keyframe koyar. Orijinal dosya `.orig` olarak saklanır. Eksik parçalar onarımla geri gelmez, onlar için "Yeniden indir" kullanılmalı.

Ayarlar'daki **Derin kontrol** her dosyayı baştan sona decode ederek bozuk kare arar. Yavaş olduğu için varsayılan olarak kapalı. Her indirmenin `yt-dlp --verbose` logu `%APPDATA%\TabCatch\logs` altında saklanır.

## Geliştirme

Gereksinim: Node.js 22+.

```bash
npm install
```

```bash
npm start
```

`npm start` eklentiyi derler (`extension/dist`), uygulamayı derler ve Electron'u açar.

```bash
npm test
```

```bash
npm run typecheck
```

Installer (Windows'ta çalıştırılmalı) `app/release/` altına üretilir:

```bash
npm run dist
```

### Eklentiyi yükleme

1. `chrome://extensions`, `edge://extensions` veya `opera://extensions` sayfasını aç.
2. Geliştirici modunu aç.
3. **Paketlenmemiş öğe yükle** butonuna bas ve `extension/dist` klasörünü seç. Eklentinin eski bir sürümü yüklüyse eklentiler sayfasında **Yeniden yükle** butonuna bas. 0.2.0 cookie, 0.3.0 sağ tık menüsü, 0.4.0 ağ trafiği izni ekledi. Kurulu uygulamada bu klasör uygulamadaki "Eklenti klasörünü aç" butonuyla açılır.

Tarayıcılar mağaza dışındaki eklentilerin otomatik kurulmasına izin vermiyor. Bu adım ancak eklenti Chrome Web Store / Edge Add-ons'a yayınlanırsa tek tıklamaya iner. Manifest'teki `key`'in özel anahtarı repoda yok; mağazaya yüklerken ya da `.crx` paketlerken yeni bir anahtar üretilmesi gerekecek.

## Klasör yapısı

```
shared/protocol.ts          eklenti <-> uygulama mesajları, URL filtresi, cookies.txt
shared/media.ts             ağ trafiğinden video adayı sınıflandırma
extension/                  MV3 köprü eklenti (tab listesi, cookie, sağ tık, ağ dinleyici)
app/electron/main.ts        pencere, tepsi, bildirim, IPC, akış
app/electron/bridge.ts      WebSocket sunucusu + origin kontrolü
app/electron/deps/          paket tanımları, kontrol, checksum doğrulamalı kurulum
app/electron/downloader.ts  sıralı kuyruk, duraklat/devam, atlama, çakışma, otomatik tekrar
app/electron/queueStore.ts  kuyruğun diske kaydı
app/electron/history.ts     indirme geçmişi
app/electron/probe.ts       ön kontrol ve playlist listeleme
app/electron/cookies.ts     cookie politikası ve geçici cookie dosyası
app/electron/ytdlp.ts       yt-dlp argümanları, progress/sonuç parse, bölüm
app/electron/verify.ts      ffprobe doğrulama, boşluk tespiti, onarım
app/renderer/               React arayüz
tests/                      vitest
```

## Kapsam dışı / bilinen sınırlar

- DRM'li içerik (Netflix vb.) indirilemez; ağdan yakalanan DRM'li akışlar "DRM korumalı" hatası verir.
- Ağdan yakalanan akışlarda token'lı URL'ler zamanla geçersizleşir; tab açıkken indirmek gerekir. Bu öğeler için "daha önce indirildi" tespiti URL'ye dayandığından, aynı video yeni bir token'la tekrar eklenirse tanınmaz.
- YouTube için cookie gönderimi varsayılan olarak kapalı (Ayarlar → "YouTube için de gönder"). Herkese açık videolar cookie istemiyor ve yt-dlp, giriş yapılmış hesapla yoğun kullanımda hesabın kısıtlanabileceği konusunda uyarıyor.
- `--cookies-from-browser` kullanılmıyor: Chrome 127+'nın app-bound encryption'ı yüzünden Windows'ta Chrome/Edge cookie'leri bu yolla güvenilir şekilde okunamıyor. Bunun yerine cookie'ler eklentiden alınıyor.
- Eklenti, cookie okuyabilmek için "tüm sitelerdeki verileri okuma" izni istiyor. Bu izin geri alınırsa uygulama üst barda "cookie izni yok" gösterir ve cookie göndermeden indirmeyi dener.
- Installer imzasız olduğu için Windows SmartScreen uyarı verir.
- YouTube'dan indirme YouTube'un kullanım koşullarına aykırıdır; sorumluluk kullanıcıya aittir.
