import type { DepStatus } from '../../electron/deps/check';
import type { InstallProgress } from '../../electron/deps/install';
import type { DepId } from '../../electron/deps/manifest';
import type { QueueItem } from '../../electron/downloader';
import type { Settings } from '../../electron/settings';
import type { BridgeClient, BrowserTabs } from '../../electron/bridge';
import type { VerifyResult } from '../../electron/verify';

export type { DepStatus, InstallProgress, DepId, QueueItem, Settings, BridgeClient, BrowserTabs, VerifyResult };

export interface TabCatchApi {
  deps: {
    status(): Promise<DepStatus[]>;
    install(ids?: DepId[]): Promise<DepStatus[]>;
    checkUpdates(): Promise<DepStatus[]>;
  };
  bridge: { clients(): Promise<BridgeClient[]> };
  tabs: { refresh(): Promise<BrowserTabs[]> };
  queue: {
    list(): Promise<QueueItem[]>;
    add(entries: { url: string; title: string; browser?: string }[]): Promise<QueueItem[]>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    log(id: string): Promise<string>;
    repair(id: string, mode: 'remux' | 'reencode'): Promise<VerifyResult>;
    show(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    chooseFolder(): Promise<Settings>;
  };
  extension: { openFolder(): Promise<string> };
  on(channel: 'deps:status', cb: (s: DepStatus[]) => void): () => void;
  on(channel: 'deps:progress', cb: (p: InstallProgress & { error?: string }) => void): () => void;
  on(channel: 'queue:update', cb: (q: QueueItem[]) => void): () => void;
  on(channel: 'bridge:clients', cb: (c: BridgeClient[]) => void): () => void;
  on(channel: 'app:error', cb: (msg: string) => void): () => void;
}

declare global {
  interface Window {
    tabcatch: TabCatchApi;
  }
}

export const api = (): TabCatchApi => window.tabcatch;

/** Electron prefixes errors thrown in ipcMain handlers; show only the message. */
export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
