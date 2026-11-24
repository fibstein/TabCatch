import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Bridge, isAllowedOrigin } from '../app/electron/bridge';

const PORT = 47999;
const ID = 'gmnikljdephmcpmopgefkeggmombghhj';
let bridge: Bridge | undefined;
afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

function connect(origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('isAllowedOrigin', () => {
  it('accepts only the extension origin', () => {
    expect(isAllowedOrigin(`chrome-extension://${ID}`, [ID])).toBe(true);
    expect(isAllowedOrigin('https://evil.example', [ID])).toBe(false);
    expect(isAllowedOrigin(`chrome-extension://${ID}x`, [ID])).toBe(false);
    expect(isAllowedOrigin(undefined, [ID])).toBe(false);
  });
});

describe('Bridge', () => {
  it('rejects web pages and accepts the extension', async () => {
    bridge = new Bridge(PORT, () => [ID]);
    await bridge.start();
    await expect(connect('https://evil.example')).rejects.toThrow(/401|403/);

    const ext = await connect(`chrome-extension://${ID}`);
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'requestTabs') {
        ext.send(JSON.stringify({ type: 'tabs', requestId: msg.requestId, browser: 'opera', tabs: [{ tabId: 7, windowId: 1, url: 'https://v', title: 'V' }] }));
      }
    });
    ext.send(JSON.stringify({ type: 'hello', browser: 'opera', extensionVersion: '0.1.0' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.clients()).toMatchObject([{ browser: 'opera', extensionVersion: '0.1.0' }]);

    const res = await bridge.requestTabs(1000);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ browser: 'opera', tabs: [{ url: 'https://v' }] });
    ext.close();
  });

  it('fetches cookies from one specific browser', async () => {
    bridge = new Bridge(PORT, () => [ID]);
    await bridge.start();
    const ext = await connect(`chrome-extension://${ID}`);
    const asked: unknown[] = [];
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'requestCookies') {
        asked.push({ url: msg.url, tabId: msg.tabId });
        ext.send(JSON.stringify({ type: 'cookies', requestId: msg.requestId, cookies: [{ domain: '.v.com', hostOnly: false, path: '/', secure: true, httpOnly: true, name: 's', value: '1' }] }));
      }
    });
    ext.send(JSON.stringify({ type: 'hello', browser: 'edge', extensionVersion: '0.2.0', canReadCookies: true }));
    await new Promise((r) => setTimeout(r, 50));
    const [client] = bridge.clients();
    expect(client.canReadCookies).toBe(true);
    const r = await bridge.requestCookies(client.id, 'https://v.com/watch', 5, 1000);
    expect(asked).toEqual([{ url: 'https://v.com/watch', tabId: 5 }]);
    expect(r?.cookies).toMatchObject([{ name: 's', httpOnly: true }]);
    expect(await bridge.requestCookies('unknown', 'https://v.com')).toBeNull();
    ext.close();
  });

  it('skips browsers that do not answer', async () => {
    bridge = new Bridge(PORT, () => [ID]);
    await bridge.start();
    const silent = await connect(`chrome-extension://${ID}`);
    await new Promise((r) => setTimeout(r, 20));
    expect(await bridge.requestTabs(100)).toEqual([]);
    expect(await bridge.requestCookies(bridge.clients()[0].id, 'https://v.com', undefined, 100)).toBeNull();
    silent.close();
  });
});
