import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { BRIDGE_HOST, parseExtMessage, type AppToExt, type BrowserName, type CookieInfo, type TabInfo } from '../../shared/protocol';

export interface BridgeClient {
  id: string;
  browser: BrowserName;
  extensionVersion: string;
  /** False for older extension versions or when the user withdrew site access. */
  canReadCookies: boolean;
}

export interface BrowserTabs {
  clientId: string;
  browser: BrowserName;
  tabs: TabInfo[];
}

/**
 * Only the TabCatch extension may connect. Browsers always send the real Origin header,
 * and a web page cannot forge `chrome-extension://<id>`.
 */
export function isAllowedOrigin(origin: string | undefined, allowedIds: readonly string[]): boolean {
  if (!origin) return false;
  return allowedIds.some((id) => origin === `chrome-extension://${id}`);
}

interface Conn {
  ws: WebSocket;
  client: BridgeClient;
}

export class Bridge extends EventEmitter {
  private wss?: WebSocketServer;
  private conns = new Map<string, Conn>();
  private pending = new Map<string, (r: BrowserTabs) => void>();
  private pendingCookies = new Map<string, (r: { cookies: CookieInfo[]; error?: string }) => void>();

  constructor(
    private readonly port: number,
    private readonly getAllowedIds: () => readonly string[],
  ) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: BRIDGE_HOST,
        port: this.port,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info: { origin: string; req: IncomingMessage }) =>
          isAllowedOrigin(info.origin ?? info.req.headers.origin, this.getAllowedIds()),
      });
      wss.once('listening', () => resolve());
      wss.once('error', reject);
      wss.on('connection', (ws) => this.onConnection(ws));
      this.wss = wss;
    });
  }

  async stop(): Promise<void> {
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  clients(): BridgeClient[] {
    return [...this.conns.values()].map((c) => c.client);
  }

  /** Asks every connected browser for its tabs; browsers that don't answer in time are skipped. */
  async requestTabs(timeoutMs = 3000): Promise<BrowserTabs[]> {
    const jobs = [...this.conns.values()].map(
      (conn) =>
        new Promise<BrowserTabs | null>((resolve) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            resolve(null);
          }, timeoutMs);
          this.pending.set(requestId, (r) => {
            clearTimeout(timer);
            resolve(r);
          });
          this.send(conn.ws, { type: 'requestTabs', requestId });
        }),
    );
    return (await Promise.all(jobs)).filter((r): r is BrowserTabs => r !== null);
  }

  /**
   * Asks one browser for the cookies it would send to `url`. Resolves null when that browser
   * is gone or does not answer; the download then proceeds without cookies.
   */
  requestCookies(clientId: string, url: string, tabId?: number, timeoutMs = 3000): Promise<{ cookies: CookieInfo[]; error?: string } | null> {
    const conn = this.conns.get(clientId);
    if (!conn) return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingCookies.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pendingCookies.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send(conn.ws, { type: 'requestCookies', requestId, url, tabId });
    });
  }

  private send(ws: WebSocket, msg: AppToExt) {
    ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket) {
    const id = randomUUID();
    const conn: Conn = { ws, client: { id, browser: 'unknown', extensionVersion: '', canReadCookies: false } };
    this.conns.set(id, conn);
    this.emit('clients', this.clients());

    ws.on('message', (data) => {
      const msg = parseExtMessage(data.toString());
      if (!msg) return;
      if (msg.type === 'ping') this.send(ws, { type: 'pong' });
      else if (msg.type === 'hello') {
        conn.client = { id, browser: msg.browser, extensionVersion: msg.extensionVersion, canReadCookies: msg.canReadCookies };
        this.emit('clients', this.clients());
      } else if (msg.type === 'cookies') {
        const resolve = this.pendingCookies.get(msg.requestId);
        if (resolve) {
          this.pendingCookies.delete(msg.requestId);
          resolve({ cookies: msg.cookies, error: msg.error });
        }
      } else if (msg.type === 'tabs') {
        const resolve = this.pending.get(msg.requestId);
        if (resolve) {
          this.pending.delete(msg.requestId);
          resolve({ clientId: id, browser: msg.browser, tabs: msg.tabs });
        }
      }
    });
    ws.on('close', () => {
      this.conns.delete(id);
      this.emit('clients', this.clients());
    });
    ws.on('error', () => ws.terminate());
  }
}
