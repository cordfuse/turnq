import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { ToknError } from './errors.ts';
import type { ChannelInfo } from './protocol.ts';

export interface ToknServerOptions {
  apiKey?: string;
  auth?: (req: IncomingMessage) => boolean | Promise<boolean>;
  port?: number;
}

interface Subscriber {
  type: 'ws' | 'sse';
  send(event: string, data: unknown): void;
  close(): void;
}

interface QueueEntry {
  clientId: string;
  requestId: string;
  subscriber: Subscriber | null;
}

interface Channel {
  name: string;
  leaseMs: number;
  maxDepth?: number;
  queue: QueueEntry[];
  active: QueueEntry | null;
  leaseTimer: ReturnType<typeof setTimeout> | null;
  observers: Set<Subscriber>;
}

export class ToknServer {
  private opts: ToknServerOptions;
  private channels = new Map<string, Channel>();
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ noServer: true });

  constructor(opts?: ToknServerOptions) {
    this.opts = opts ?? {};
    this.app.use(express.json());
    this.setupRoutes();
    this.setupWss();
  }

  private async checkAuth(req: IncomingMessage): Promise<boolean> {
    if (this.opts.auth) return this.opts.auth(req);
    if (!this.opts.apiKey) return true;
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header === this.opts.apiKey) return true;
    // query param fallback (used by WSS clients)
    const url = new URL(req.url ?? '/', 'http://localhost');
    const qp = url.searchParams.get('apiKey') ?? url.searchParams.get('x-api-key');
    return qp === this.opts.apiKey;
  }

  private authMiddleware = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const ok = await this.checkAuth(req as unknown as IncomingMessage);
    if (!ok) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing API key' });
      return;
    }
    next();
  };

  private sendSse(res: express.Response, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(ch: Channel, event: string, data: unknown) {
    for (const obs of ch.observers) {
      obs.send(event, data);
    }
  }

  private grantTurn(ch: Channel) {
    if (ch.active || ch.queue.length === 0) return;
    const entry = ch.queue[0];
    ch.active = entry;
    const leaseExpiresAt = Date.now() + ch.leaseMs;

    this.broadcast(ch, 'turn-started', { channel: ch.name, clientId: entry.clientId });

    if (entry.subscriber) {
      entry.subscriber.send('your-turn', {
        channel: ch.name,
        requestId: entry.requestId,
        leaseExpiresAt,
      });
    }

    ch.leaseTimer = setTimeout(() => this.expireLease(ch), ch.leaseMs);

    // notify waiting queue members of their new positions
    for (let i = 1; i < ch.queue.length; i++) {
      const e = ch.queue[i];
      e.subscriber?.send('position-updated', {
        channel: ch.name,
        requestId: e.requestId,
        position: i,
      });
    }
  }

  private expireLease(ch: Channel) {
    if (!ch.active) return;
    const entry = ch.active;
    entry.subscriber?.send('timeout', {
      channel: ch.name,
      requestId: entry.requestId,
      reason: 'lease_expired',
    });
    this.broadcast(ch, 'turn-completed', {
      channel: ch.name,
      clientId: entry.clientId,
      success: false,
      error: 'LEASE_EXPIRED',
    });
    entry.subscriber?.close();
    entry.subscriber = null;
    ch.active = null;
    ch.leaseTimer = null;
    ch.queue.shift();
    this.grantTurn(ch);
  }

  private releaseTurn(ch: Channel, success: boolean, error?: string) {
    if (!ch.active) return;
    const entry = ch.active;
    if (ch.leaseTimer) {
      clearTimeout(ch.leaseTimer);
      ch.leaseTimer = null;
    }
    this.broadcast(ch, 'turn-completed', {
      channel: ch.name,
      clientId: entry.clientId,
      success,
      error,
    });
    entry.subscriber?.close();
    entry.subscriber = null;
    ch.active = null;
    ch.queue.shift();
    this.grantTurn(ch);
  }

  private handleWsDisconnect(ch: Channel, entry: QueueEntry, ws: WebSocket) {
    if (ch.active === entry) {
      if (ch.leaseTimer) {
        clearTimeout(ch.leaseTimer);
        ch.leaseTimer = null;
      }
      this.broadcast(ch, 'turn-completed', {
        channel: ch.name,
        clientId: entry.clientId,
        success: false,
        error: 'CLIENT_DISCONNECTED',
      });
      entry.subscriber = null;
      ch.active = null;
      ch.queue.shift();
      this.grantTurn(ch);
    } else {
      const idx = ch.queue.indexOf(entry);
      if (idx !== -1) {
        ch.queue.splice(idx, 1);
        // update positions for remaining queue members
        for (let i = idx; i < ch.queue.length; i++) {
          const e = ch.queue[i];
          e.subscriber?.send('position-updated', {
            channel: ch.name,
            requestId: e.requestId,
            position: i + 1,
          });
        }
      }
    }
  }

  private makeWsSubscriber(ws: WebSocket): Subscriber {
    return {
      type: 'ws',
      send(event, data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event, data }));
        }
      },
      close() {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      },
    };
  }

  private makeSseSubscriber(res: express.Response): Subscriber {
    return {
      type: 'sse',
      send: (event, data) => this.sendSse(res, event, data),
      close: () => res.end(),
    };
  }

  private attachSubscriber(ch: Channel, entry: QueueEntry, sub: Subscriber) {
    entry.subscriber = sub;
    const idx = ch.queue.indexOf(entry);
    if (ch.active === entry) {
      // already active — send your-turn immediately
      const leaseExpiresAt = Date.now() + ch.leaseMs;
      sub.send('your-turn', {
        channel: ch.name,
        requestId: entry.requestId,
        leaseExpiresAt,
      });
    } else if (idx > 0) {
      sub.send('queued', { channel: ch.name, requestId: entry.requestId, position: idx });
    } else if (idx === 0 && !ch.active) {
      // raced: enqueue on empty channel, now subscribe arrives
      this.grantTurn(ch);
    }
  }

  private setupRoutes() {
    const app = this.app;
    const auth = this.authMiddleware;

    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });

    app.post('/channels', auth, (req, res) => {
      const { name, leaseMs = 30000, maxDepth } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'name required' });
        return;
      }
      if (this.channels.has(name)) {
        res.status(409).json({ code: 'CHANNEL_EXISTS', message: `Channel ${name} already exists` });
        return;
      }
      const ch: Channel = {
        name,
        leaseMs,
        maxDepth,
        queue: [],
        active: null,
        leaseTimer: null,
        observers: new Set(),
      };
      this.channels.set(name, ch);
      res.status(201).json({ name, leaseMs, maxDepth });
    });

    app.delete('/channels/:name', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      if (ch.queue.length > 0 || ch.active) {
        res.status(409).json({ code: 'CHANNEL_NOT_EMPTY', message: 'Channel has active or queued clients' });
        return;
      }
      this.channels.delete(ch.name);
      res.status(204).end();
    });

    app.get('/channels', auth, (_req, res) => {
      const channels: ChannelInfo[] = [];
      for (const ch of this.channels.values()) {
        channels.push({
          name: ch.name,
          leaseMs: ch.leaseMs,
          maxDepth: ch.maxDepth,
          depth: ch.queue.length,
          active: ch.active?.clientId ?? null,
        });
      }
      res.json({ channels });
    });

    app.post('/channels/:name/enqueue', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const { clientId } = req.body ?? {};
      if (!clientId) {
        res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'clientId required' });
        return;
      }
      const alreadyQueued = ch.queue.some((e) => e.clientId === clientId);
      if (alreadyQueued) {
        res.status(409).json({ code: 'ALREADY_QUEUED', message: 'Client already in queue' });
        return;
      }
      if (ch.maxDepth !== undefined && ch.queue.length >= ch.maxDepth) {
        res.status(429).json({ code: 'MAX_DEPTH_EXCEEDED', message: 'Channel queue is full' });
        return;
      }
      const entry: QueueEntry = { clientId, requestId: randomUUID(), subscriber: null };
      ch.queue.push(entry);
      const position = ch.queue.length - 1;
      // position 0 = active slot; if nothing active and this is position 0, grant will happen on subscribe
      res.status(200).json({ requestId: entry.requestId, position });
    });

    // SSE subscribe
    app.get('/channels/:name/subscribe', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const { clientId, requestId } = req.query as Record<string, string>;
      const entry =
        (ch.active?.clientId === clientId && ch.active?.requestId === requestId ? ch.active : null) ??
        ch.queue.find((e) => e.clientId === clientId && e.requestId === requestId) ??
        null;
      if (!entry) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'No matching queue entry' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sub = this.makeSseSubscriber(res);
      this.attachSubscriber(ch, entry, sub);

      req.on('close', () => {
        this.handleWsDisconnect(ch, entry, null as unknown as WebSocket);
      });
    });

    app.post('/channels/:name/release', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const { clientId, requestId, result } = req.body ?? {};
      if (!ch.active || ch.active.clientId !== clientId || ch.active.requestId !== requestId) {
        res.status(403).json({ code: 'NOT_YOUR_TURN', message: 'Not the active turn holder' });
        return;
      }
      const success = result?.success ?? true;
      const error = result?.error;
      this.releaseTurn(ch, success, error);
      res.status(204).end();
    });

    app.post('/channels/:name/abort', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const { clientId } = req.body ?? {};
      if (ch.active?.clientId === clientId) {
        this.releaseTurn(ch, false, 'ABORTED');
      } else {
        const idx = ch.queue.findIndex((e) => e.clientId === clientId);
        if (idx !== -1) {
          const [removed] = ch.queue.splice(idx, 1);
          removed.subscriber?.close();
          for (let i = idx; i < ch.queue.length; i++) {
            const e = ch.queue[i];
            e.subscriber?.send('position-updated', {
              channel: ch.name,
              requestId: e.requestId,
              position: i + 1,
            });
          }
          // if idx was 0 and nothing active, grant turn to new queue[0]
          if (idx === 0 && !ch.active) this.grantTurn(ch);
        }
      }
      res.status(204).end();
    });

    app.post('/channels/:name/steps', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const { clientId, step, event, success, error } = req.body ?? {};
      if (!ch.active || ch.active.clientId !== clientId) {
        res.status(403).json({ code: 'NOT_YOUR_TURN', message: 'Not the active turn holder' });
        return;
      }
      if (event === 'start') {
        this.broadcast(ch, 'step-started', { channel: ch.name, clientId, step });
      } else {
        this.broadcast(ch, 'step-ended', { channel: ch.name, clientId, step, success: success ?? true, error });
      }
      res.status(204).end();
    });

    // SSE observe
    app.get('/channels/:name/observe', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sub = this.makeSseSubscriber(res);
      ch.observers.add(sub);
      req.on('close', () => ch.observers.delete(sub));
    });
  }

  private setupWss() {
    this.httpServer.on('upgrade', async (req: IncomingMessage, socket, head) => {
      const ok = await this.checkAuth(req);
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      const subMatch = path.match(/^\/channels\/([^/]+)\/subscribe$/);
      const obsMatch = path.match(/^\/channels\/([^/]+)\/observe$/);

      if (subMatch) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWsSubscribe(ws, req, subMatch[1]);
        });
      } else if (obsMatch) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWsObserve(ws, req, obsMatch[1]);
        });
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });
  }

  private handleWsSubscribe(ws: WebSocket, req: IncomingMessage, channelName: string) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const clientId = url.searchParams.get('clientId') ?? '';
    const requestId = url.searchParams.get('requestId') ?? '';

    const ch = this.channels.get(channelName);
    if (!ch) {
      ws.close(1008, 'CHANNEL_NOT_FOUND');
      return;
    }

    const entry =
      (ch.active?.clientId === clientId && ch.active?.requestId === requestId ? ch.active : null) ??
      ch.queue.find((e) => e.clientId === clientId && e.requestId === requestId) ??
      null;

    if (!entry) {
      ws.close(1008, 'NO_MATCHING_ENTRY');
      return;
    }

    const sub = this.makeWsSubscriber(ws);
    this.attachSubscriber(ch, entry, sub);

    ws.on('close', () => this.handleWsDisconnect(ch, entry, ws));
  }

  private handleWsObserve(ws: WebSocket, req: IncomingMessage, channelName: string) {
    const ch = this.channels.get(channelName);
    if (!ch) {
      ws.close(1008, 'CHANNEL_NOT_FOUND');
      return;
    }
    const sub = this.makeWsSubscriber(ws);
    ch.observers.add(sub);
    ws.on('close', () => ch.observers.delete(sub));
  }

  async start(port?: number): Promise<void> {
    const p = port ?? this.opts.port ?? 3000;
    return new Promise((resolve) => {
      this.httpServer.listen(p, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const ch of this.channels.values()) {
      if (ch.leaseTimer) clearTimeout(ch.leaseTimer);
      // close any open subscriber/observer connections
      for (const entry of ch.queue) entry.subscriber?.close();
      for (const obs of ch.observers) obs.close();
    }
    // terminate all open WS clients so wss.close() doesn't hang
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.httpServer.closeAllConnections?.();
    this.wss.close();
    return new Promise((resolve, reject) => {
      if (!this.httpServer.listening) {
        resolve();
        return;
      }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
