import EventEmitter from 'events';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { ToknError } from './errors.ts';
import type { ChannelInfo } from './protocol.ts';

export interface ToknClientOptions {
  apiKey?: string;
  preferSse?: boolean;
  maxReconnectAttempts?: number;
}

export interface WithTurnOptions {
  maxWaitMs?: number;
}

export interface TurnContext {
  withStep(name: string, fn: () => Promise<void>): Promise<void>;
}

async function connectWss(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function* parseSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        yield { event: currentEvent, data: JSON.parse(line.slice(5).trim()) };
        currentEvent = '';
      }
    }
  }
}

export class ToknClient extends EventEmitter {
  private baseUrl: string;
  private opts: ToknClientOptions;
  private headers: Record<string, string>;

  constructor(url: string, opts?: ToknClientOptions) {
    super();
    this.baseUrl = url.replace(/\/$/, '');
    this.opts = opts ?? {};
    this.headers = opts?.apiKey ? { 'x-api-key': opts.apiKey } : {};
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    return res;
  }

  async createChannel(name: string, opts?: { leaseMs?: number; maxDepth?: number; maxWaitMs?: number }): Promise<void> {
    const res = await this.fetch('/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...opts }),
    });
    if (!res.ok && res.status !== 409) {
      const body = await res.json().catch(() => ({}));
      throw new ToknError(body.code ?? 'INTERNAL_ERROR', body.message ?? 'createChannel failed');
    }
  }

  async deleteChannel(name: string): Promise<void> {
    const res = await this.fetch(`/channels/${name}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ToknError(body.code ?? 'INTERNAL_ERROR', body.message ?? 'deleteChannel failed');
    }
  }

  async listChannels(): Promise<ChannelInfo[]> {
    const res = await this.fetch('/channels');
    const body = await res.json();
    return body.channels;
  }

  async withTurn(
    channel: string,
    fn: (ctx: TurnContext) => Promise<void>,
    clientId?: string,
    opts?: WithTurnOptions,
  ): Promise<void> {
    const cid = clientId ?? randomUUID();

    const enqRes = await this.fetch(`/channels/${channel}/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: cid }),
    });
    if (!enqRes.ok) {
      const body = await enqRes.json().catch(() => ({}));
      throw new ToknError(body.code ?? 'INTERNAL_ERROR', body.message ?? 'enqueue failed');
    }
    const { requestId } = await enqRes.json();

    await this.runWithReconnect(channel, cid, requestId, fn, opts);
  }

  private async runWithReconnect(
    channel: string,
    clientId: string,
    requestId: string,
    fn: (ctx: TurnContext) => Promise<void>,
    opts?: WithTurnOptions,
  ): Promise<void> {
    const maxAttempts = this.opts.maxReconnectAttempts ?? 5;
    let attempt = 0;

    while (true) {
      try {
        return await this.runWithSubscription(channel, clientId, requestId, fn);
      } catch (err) {
        // protocol errors (lease expired, not your turn, etc.) — don't retry
        if (err instanceof ToknError) throw err;

        if (attempt >= maxAttempts) throw err;
        attempt++;

        const backoffMs = Math.min(100 * Math.pow(2, attempt), 5000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  private async runWithSubscription(
    channel: string,
    clientId: string,
    requestId: string,
    fn: (ctx: TurnContext) => Promise<void>,
  ): Promise<void> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const apiKeyParam = this.opts.apiKey ? `&apiKey=${encodeURIComponent(this.opts.apiKey)}` : '';
    const wsUrl = `${wsBase}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;

    if (!this.opts.preferSse) {
      try {
        const ws = await connectWss(wsUrl, this.headers);
        return await this.runWs(ws, channel, clientId, requestId, fn);
      } catch {
        // fall through to SSE
      }
    }

    return await this.runSse(channel, clientId, requestId, fn);
  }

  private async runWs(
    ws: WebSocket,
    channel: string,
    clientId: string,
    requestId: string,
    fn: (ctx: TurnContext) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.on('message', async (raw) => {
        let msg: { event: string; data: unknown };
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.event === 'your-turn') {
          ws.removeAllListeners('message');
          ws.removeAllListeners('error');
          try {
            await fn(this.makeTurnContext(channel, clientId));
            await this.release(channel, clientId, requestId, true);
            ws.close();
            resolve();
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            await this.release(channel, clientId, requestId, false, m).catch(() => {});
            ws.close();
            reject(err);
          }
        } else if (msg.event === 'timeout') {
          ws.close();
          this.emit('timeout', { channel, requestId });
          reject(new ToknError('LEASE_EXPIRED', 'Turn timed out'));
        } else if (msg.event === 'server-shutdown') {
          ws.close();
          reject(new Error('server_shutdown'));
        }
      });

      ws.on('error', (err) => reject(err));
      ws.on('close', (code) => {
        if (code !== 1000) reject(new Error(`WebSocket closed: ${code}`));
      });
    });
  }

  private async runSse(
    channel: string,
    clientId: string,
    requestId: string,
    fn: (ctx: TurnContext) => Promise<void>,
  ): Promise<void> {
    const apiKeyParam = this.opts.apiKey ? `&apiKey=${encodeURIComponent(this.opts.apiKey)}` : '';
    const url = `${this.baseUrl}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`);

    for await (const { event, data } of parseSse(res.body as ReadableStream<Uint8Array>)) {
      if (event === 'your-turn') {
        try {
          await fn(this.makeTurnContext(channel, clientId));
          await this.release(channel, clientId, requestId, true);
          return;
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          await this.release(channel, clientId, requestId, false, m).catch(() => {});
          throw err;
        }
      } else if (event === 'timeout') {
        this.emit('timeout', { channel, requestId });
        throw new ToknError('LEASE_EXPIRED', 'Turn timed out');
      } else if (event === 'server-shutdown') {
        throw new Error('server_shutdown');
      }
    }
  }

  private makeTurnContext(channel: string, clientId: string): TurnContext {
    return {
      withStep: async (name, fn) => {
        await this.fetch(`/channels/${channel}/steps`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId, step: name, event: 'start' }),
        });
        try {
          await fn();
          await this.fetch(`/channels/${channel}/steps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, step: name, event: 'end', success: true }),
          });
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          await this.fetch(`/channels/${channel}/steps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, step: name, event: 'end', success: false, error: m }),
          }).catch(() => {});
          throw err;
        }
      },
    };
  }

  private async release(channel: string, clientId: string, requestId: string, success: boolean, error?: string) {
    await this.fetch(`/channels/${channel}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, requestId, result: { success, error } }),
    });
  }

  close(): void {
    // nothing persistent to close on the client side
  }
}
