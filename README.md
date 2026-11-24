# TabCatch

Chrome, Edge ve Opera'da açık olan tablardaki videoları [yt-dlp](https://github.com/yt-dlp/yt-dlp) ile sırayla indiren Windows uygulaması.

## Nasıl çalışır

```
[Tarayıcı eklentisi] --WebSocket 127.0.0.1:47863--> [TabCatch (Electron)] --> yt-dlp.exe / ffmpeg.exe / deno.exe
  açık tab listesi                                    kuyruk, doğrulama, onarım
```

- **Neden eklenti var?** Tarayıcılar açık tabların listesini dışarıdaki programlara vermiyor. Chrome 136'dan beri `--remote-debugging-port` normal profilde de çalışmıyor. Eklentinin tek görevi tab listesini uygulamaya göndermek.
- **Güvenlik:** Uygulama yalnızca `127.0.0.1`'i dinliyor ve sadece `chrome-extension://gmnikljdephmcpmopgefkeggmombghhj` origin'inden gelen bağlantıları kabul ediyor. Web sayfaları bu origin'i taklit edemez. Eklenti ID'si `extension/manifest.json` içindeki `key` alanıyla sabitlendiği için Chrome, Edge ve Opera'da aynı.

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
3. **Paketlenmemiş öğe yükle** butonuna bas ve `extension/dist` klasörünü seç. Kurulu uygulamada bu klasör uygulamadaki "Eklenti klasörünü aç" butonuyla açılır.

Tarayıcılar mağaza dışındaki eklentilerin otomatik kurulmasına izin vermiyor. Bu adım ancak eklenti Chrome Web Store / Edge Add-ons'a yayınlanırsa tek tıklamaya iner. Manifest'teki `key`'in özel anahtarı repoda yok; mağazaya yüklerken ya da `.crx` paketlerken yeni bir anahtar üretilmesi gerekecek.

## Klasör yapısı

```
shared/protocol.ts          eklenti <-> uygulama mesajları, URL filtresi
extension/                  MV3 köprü eklenti (tab listesi, WebSocket istemcisi)
app/electron/main.ts        pencere, IPC, akış
app/electron/bridge.ts      WebSocket sunucusu + origin kontrolü
app/electron/deps/          paket tanımları, kontrol, checksum doğrulamalı kurulum
app/electron/downloader.ts  sıralı kuyruk, otomatik tekrar
app/electron/ytdlp.ts       yt-dlp argümanları, progress/sonuç parse
app/electron/verify.ts      ffprobe doğrulama, boşluk tespiti, onarım
app/renderer/               React arayüz
tests/                      vitest
```

## Kapsam dışı / bilinen sınırlar

- DRM'li içerik (Netflix vb.) indirilemez.
- Giriş gerektiren videolar henüz desteklenmiyor. Planlanan çözüm, cookie'leri eklenti üzerinden `cookies.txt` olarak aktarmak; `--cookies-from-browser` Chrome 127+'da Windows'ta güvenilir çalışmıyor.
- Installer imzasız olduğu için Windows SmartScreen uyarı verir.
- YouTube'dan indirme YouTube'un kullanım koşullarına aykırıdır; sorumluluk kullanıcıya aittir.
