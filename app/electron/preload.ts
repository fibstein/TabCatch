import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  deps: {
    status: () => invoke('deps:status'),
    install: (ids?: string[]) => invoke('deps:install', ids),
    checkUpdates: () => invoke('deps:checkUpdates'),
  },
  bridge: { clients: () => invoke('bridge:clients') },
  tabs: { refresh: () => invoke('tabs:refresh') },
  queue: {
    list: () => invoke('queue:list'),
    add: (entries: unknown[]) => invoke('queue:add', entries),
    cancel: (id: string) => invoke('queue:cancel', id),
    pause: (id: string) => invoke('queue:pause', id),
    resume: (id: string) => invoke('queue:resume', id),
    force: (id: string) => invoke('queue:force', id),
    setPaused: (paused: boolean) => invoke('queue:setPaused', paused),
    isPaused: () => invoke('queue:isPaused'),
    retry: (id: string) => invoke('queue:retry', id),
    remove: (id: string) => invoke('queue:remove', id),
    log: (id: string) => invoke('queue:log', id),
    repair: (id: string, mode: 'remux' | 'reencode') => invoke('queue:repair', id, mode),
    show: (id: string) => invoke('file:show', id),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch),
    chooseFolder: () => invoke('settings:chooseFolder'),
  },
  extension: { openFolder: () => invoke('extension:openFolder') },
  on,
};

contextBridge.exposeInMainWorld('tabcatch', api);
export type TabCatchApi = typeof api;
