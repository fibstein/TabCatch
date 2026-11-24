import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_PORT, isCandidateUrl } from '../../shared/protocol';
import { Bridge } from './bridge';
import { checkDeps, checkUpdates, type DepStatus } from './deps/check';
import { installDep, type InstallProgress } from './deps/install';
import { exe, getDepDefs, type DepId } from './deps/manifest';
import { DownloadQueue, type QueueItem } from './downloader';
import { spawnRunner } from './runner';
import { defaultSettings, SettingsStore, type Settings } from './settings';
import { deepCheck, repairFile, verifyFile, type RepairMode, type VerifyExpectations } from './verify';
import { buildYtDlpArgs } from './ytdlp';
import { cookieDecision, deleteCookieFile, pickCookieClient, writeCookieFile } from './cookies';

const DAY_MS = 24 * 60 * 60 * 1000;

// Stable folder name in dev and packaged builds.
app.setPath('userData', join(app.getPath('appData'), 'TabCatch'));
const userData = app.getPath('userData');
// Binaries (~200 MB) go to Local AppData so roaming profiles don't sync them.
const binDir =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'TabCatch', 'bin')
    : join(userData, 'bin');
const logDir = join(userData, 'logs');
// Cookie files live only while yt-dlp runs; anything left here is from a crash and is wiped at startup.
const cookieDir = join(userData, 'cookies-tmp');
const defs = getDepDefs();
const bin = (base: string) => join(binDir, exe(base));
const fetchImpl = (url: string) => net.fetch(url); // follows the system proxy settings

const settings = new SettingsStore(join(userData, 'settings.json'), defaultSettings(join(app.getPath('downloads'), 'TabCatch')));
const bridge = new Bridge(BRIDGE_PORT, () => settings.allowedExtensionIds());

let win: BrowserWindow | null = null;
let depStatus: DepStatus[] = [];
let installing = false;
const pendingAutoUpdates = new Set<DepId>();

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function expectations(item: QueueItem, duration: number | null): VerifyExpectations {
  const audioOnly = settings.get().preset === 'audio';
  return { duration, expectVideo: !audioOnly, expectAudio: true };
}

const queue = new DownloadQueue({
  runner: (args) => spawnRunner(bin('yt-dlp'), args),
  buildArgs: async (item) => {
    const s = settings.get();
    const cookiesFile = await prepareCookies(item);
    return buildYtDlpArgs({
      url: item.url,
      outputDir: s.outputDir,
      preset: s.preset,
      ffmpegDir: binDir,
      denoPath: bin('deno'),
      fresh: item.fresh,
      cookiesFile,
    });
  },
  afterRun: (item) => deleteCookieFile(cookieDir, item.id),
  verify: async (item, result) => {
    const v = await verifyFile(bin('ffprobe'), result.filepath, expectations(item, result.duration));
    if (v.ok && settings.get().deepCheck) {
      const errors = await deepCheck(bin('ffmpeg'), result.filepath);
      if (errors.length) return { ...v, ok: false, problems: [`Decode hataları: ${errors.slice(0, 3).join(' | ')}`] };
    }
    return v;
  },
  deleteFile: (p) => rm(p, { force: true }),
  maxVerifyRetries: 1,
  onFinished: (item) => {
    void mkdir(logDir, { recursive: true }).then(() =>
      writeFile(join(logDir, `${item.id}.log`), [item.url, ...item.log].join('\n')),
    );
  },
});

queue.on('update', (items) => send('queue:update', items));
queue.on('idle', () => void applyPendingUpdates());
bridge.on('clients', (clients) => send('bridge:clients', clients));

/** Fetches the cookies for this one URL from the browser the tab is open in; never fails the download. */
async function prepareCookies(item: QueueItem): Promise<string | undefined> {
  const note = (text: string | undefined) => {
    item.cookieNote = text;
    if (text) item.log.push(`[cookie] ${text}`);
  };
  const decision = cookieDecision(item.url, settings.get());
  if (!decision.send) {
    note(decision.note);
    return undefined;
  }
  const client = pickCookieClient(bridge.clients(), item);
  if (!client) {
    note('Cookie alınamadı: tarayıcı eklentisi bağlı değil, cookie olmadan deneniyor');
    return undefined;
  }
  if (!client.canReadCookies) {
    note('Eklenti cookie okuyamıyor (eklentiyi yeniden yükle veya site erişimine izin ver), cookie olmadan deneniyor');
    return undefined;
  }
  // Tab ids are per browser connection; only pass it when talking to the original one.
  const res = await bridge.requestCookies(client.id, item.url, client.id === item.clientId ? item.tabId : undefined);
  if (!res || res.error) {
    note(`Cookie alınamadı${res?.error ? `: ${res.error}` : ' (tarayıcı yanıt vermedi)'}, cookie olmadan deneniyor`);
    return undefined;
  }
  if (!res.cookies.length) {
    note(undefined);
    return undefined;
  }
  const file = await writeCookieFile(cookieDir, item.id, res.cookies);
  note(`${res.cookies.length} cookie gönderildi (${client.browser})`);
  return file;
}

async function refreshDeps(): Promise<DepStatus[]> {
  const prev = new Map(depStatus.map((d) => [d.id, d.updateAvailable]));
  depStatus = (await checkDeps(defs, binDir)).map((d) => ({ ...d, updateAvailable: prev.get(d.id) ?? null }));
  send('deps:status', depStatus);
  return depStatus;
}

const depsReady = () => depStatus.length > 0 && depStatus.every((d) => d.state === 'ok');

async function install(ids: DepId[]): Promise<DepStatus[]> {
  if (installing) throw new Error('Kurulum zaten sürüyor');
  if (queue.isBusy()) throw new Error('İndirme sürerken bağımlılıklar güncellenemez (dosyalar kullanımda)');
  installing = true;
  queue.setPaused(true);
  const errors: string[] = [];
  try {
    for (const def of defs.filter((d) => ids.includes(d.id))) {
      try {
        await installDep(def, {
          binDir,
          fetch: fetchImpl,
          onProgress: (p: InstallProgress) => send('deps:progress', p),
        });
        depStatus = depStatus.map((d) => (d.id === def.id ? { ...d, updateAvailable: false } : d));
      } catch (err) {
        errors.push(`${def.label}: ${(err as Error).message}`);
        send('deps:progress', { depId: def.id, phase: 'done', received: 0, total: null, attempt: 0, error: (err as Error).message });
      }
    }
  } finally {
    installing = false;
    queue.setPaused(false);
  }
  await refreshDeps();
  if (errors.length) throw new Error(errors.join('\n'));
  return depStatus;
}

async function runUpdateCheck(force = false): Promise<DepStatus[]> {
  const s = settings.get();
  if (!force && Date.now() - s.lastUpdateCheck < DAY_MS) return depStatus;
  const updates = await checkUpdates(defs, binDir, fetchImpl);
  await settings.set({ lastUpdateCheck: Date.now() });
  depStatus = depStatus.map((d) => ({ ...d, updateAvailable: updates[d.id] ?? d.updateAvailable }));
  send('deps:status', depStatus);
  for (const def of defs) {
    if (updates[def.id] && def.autoUpdate && settings.get().autoUpdateYtDlp) pendingAutoUpdates.add(def.id);
  }
  await applyPendingUpdates();
  return depStatus;
}

/** Auto-updates wait until the queue is idle: Windows locks a running yt-dlp.exe. */
async function applyPendingUpdates() {
  if (!pendingAutoUpdates.size || queue.isBusy() || installing) return;
  const ids = [...pendingAutoUpdates];
  pendingAutoUpdates.clear();
  await install(ids).catch((err) => send('app:error', `Otomatik güncelleme başarısız: ${(err as Error).message}`));
}

function extensionDir(): string {
  const packaged = join(process.resourcesPath, 'extension');
  return app.isPackaged && existsSync(packaged) ? packaged : join(app.getAppPath(), '..', 'extension', 'dist');
}

function registerIpc() {
  ipcMain.handle('deps:status', () => refreshDeps());
  ipcMain.handle('deps:install', (_e, ids?: DepId[]) =>
    install(ids ?? depStatus.filter((d) => d.state !== 'ok' || d.updateAvailable).map((d) => d.id)),
  );
  ipcMain.handle('deps:checkUpdates', () => runUpdateCheck(true));

  ipcMain.handle('bridge:clients', () => bridge.clients());
  ipcMain.handle('tabs:refresh', async () => {
    const results = await bridge.requestTabs();
    return results.map((r) => ({ ...r, tabs: r.tabs.filter((t) => isCandidateUrl(t.url)) }));
  });

  ipcMain.handle('queue:list', () => queue.list());
  ipcMain.handle('queue:add', (_e, entries: { url: string; title: string; browser?: string; clientId?: string; tabId?: number }[]) => {
    if (!depsReady()) throw new Error('Önce gerekli paketler kurulmalı');
    return queue.add(entries.filter((e) => isCandidateUrl(e.url)));
  });
  ipcMain.handle('queue:cancel', (_e, id: string) => queue.cancel(id));
  ipcMain.handle('queue:retry', (_e, id: string) => queue.retry(id));
  ipcMain.handle('queue:remove', (_e, id: string) => queue.remove(id));
  ipcMain.handle('queue:log', (_e, id: string) => queue.get(id)?.log.join('\n') ?? '');
  ipcMain.handle('queue:repair', async (_e, id: string, mode: RepairMode) => {
    const item = queue.get(id);
    if (!item?.result) throw new Error('Onarılacak dosya yok');
    queue.update(id, { status: 'verifying' });
    try {
      const { path, verify } = await repairFile(
        { ffmpeg: bin('ffmpeg'), ffprobe: bin('ffprobe') },
        item.result.filepath,
        mode,
        expectations(item, item.result.duration),
      );
      queue.update(id, {
        status: verify.ok ? 'done' : 'verify_failed',
        verify,
        error: verify.ok ? undefined : verify.problems.join('; '),
        result: { ...item.result, filepath: path },
      });
      return verify;
    } catch (err) {
      queue.update(id, { status: 'verify_failed', error: (err as Error).message });
      throw err;
    }
  });
  ipcMain.handle('file:show', (_e, id: string) => {
    const p = queue.get(id)?.result?.filepath;
    if (p) shell.showItemInFolder(p);
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => settings.set(patch));
  ipcMain.handle('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get().outputDir });
    if (r.canceled || !r.filePaths[0]) return settings.get();
    return settings.set({ outputDir: r.filePaths[0] });
  });
  ipcMain.handle('extension:openFolder', () => shell.openPath(extensionDir()));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'TabCatch',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => (win = null));
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await rm(cookieDir, { recursive: true, force: true });
    registerIpc();
    createWindow();
    try {
      await bridge.start();
    } catch (err) {
      dialog.showErrorBox('TabCatch', `Eklenti bağlantı portu (${BRIDGE_PORT}) açılamadı: ${(err as Error).message}`);
    }
    await refreshDeps();
    if (depsReady()) void runUpdateCheck().catch(() => undefined);
  });

  app.on('window-all-closed', async () => {
    for (const item of queue.list()) if (item.status === 'downloading') queue.cancel(item.id);
    await bridge.stop();
    await rm(cookieDir, { recursive: true, force: true });
    app.quit();
  });
}
