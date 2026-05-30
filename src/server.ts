import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { ToknError } from './errors.ts';
import { logger } from './logger.ts';
import { metrics } from './metrics.ts';
import type { Persistence } from './persist.ts';
import type { ChannelInfo, QueueEntryInfo } from './protocol.ts';

export interface ToknServerOptions {
  apiKey?: string;
  auth?: (req: IncomingMessage) => boolean | Promise<boolean>;
  port?: number;
  heartbeatMs?: number;
  persist?: Persistence;
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
  enqueuedAt: number;
  turnStartedAt: number | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
}

interface Channel {
  name: string;
  leaseMs: number;
  maxDepth?: number;
  maxWaitMs?: number;
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
  private wsAlive = new WeakMap<WebSocket, boolean>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: ToknServerOptions) {
    this.opts = opts ?? {};
    this.app.use(express.json());
    this.app.use(this.requestLogger);
    this.setupRoutes();
    this.setupWss();
    this.setupHeartbeat();

    // restore persisted channels
    if (opts?.persist) {
      for (const ch of opts.persist.load()) {
        this.channels.set(ch.name, {
          name: ch.name,
          leaseMs: ch.leaseMs,
          maxDepth: ch.maxDepth,
          maxWaitMs: ch.maxWaitMs,
          queue: [],
          active: null,
          leaseTimer: null,
          observers: new Set(),
        });
        metrics.activeChannels.inc();
        metrics.queueDepth.set(0, { channel: ch.name });
      }
      if (this.channels.size > 0) {
        logger.info('channels restored from persistence', { count: this.channels.size });
      }
    }
  }

  private requestLogger = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const path = (req.route?.path as string | undefined) ?? req.path;
      metrics.requestsTotal.inc({ method: req.method, path, status: String(res.statusCode) });
      logger.debug('request', { method: req.method, path: req.path, status: res.statusCode, ms });
    });
    next();
  };

  private async checkAuth(req: IncomingMessage): Promise<boolean> {
    if (this.opts.auth) return this.opts.auth(req);
    if (!this.opts.apiKey) return true;
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header === this.opts.apiKey) return true;
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
    for (const obs of ch.observers) obs.send(event, data);
  }

  private grantTurn(ch: Channel) {
    if (ch.active || ch.queue.length === 0) return;
    const entry = ch.queue[0];

    // clear wait timer — they got their turn
    if (entry.waitTimer) {
      clearTimeout(entry.waitTimer);
      entry.waitTimer = null;
    }

    ch.active = entry;
    entry.turnStartedAt = Date.now();

    const waitMs = entry.turnStartedAt - entry.enqueuedAt;
    metrics.waitDuration.observe(waitMs / 1000, { channel: ch.name });

    const leaseExpiresAt = entry.turnStartedAt + ch.leaseMs;

    this.broadcast(ch, 'turn-started', { channel: ch.name, clientId: entry.clientId });

    if (entry.subscriber) {
      entry.subscriber.send('your-turn', {
        channel: ch.name,
        requestId: entry.requestId,
        leaseExpiresAt,
      });
    }

    ch.leaseTimer = setTimeout(() => this.expireLease(ch), ch.leaseMs);

    for (let i = 1; i < ch.queue.length; i++) {
      const e = ch.queue[i];
      e.subscriber?.send('position-updated', { channel: ch.name, requestId: e.requestId, position: i });
    }

    logger.info('turn granted', { channel: ch.name, clientId: entry.clientId, waitMs });
  }

  private expireLease(ch: Channel) {
    if (!ch.active) return;
    const entry = ch.active;

    if (entry.turnStartedAt !== null) {
      metrics.holdDuration.observe((Date.now() - entry.turnStartedAt) / 1000, { channel: ch.name });
    }
    metrics.timeoutsTotal.inc({ channel: ch.name, reason: 'lease_expired' });

    entry.subscriber?.send('timeout', { channel: ch.name, requestId: entry.requestId, reason: 'lease_expired' });
    ch.active = null;
    ch.leaseTimer = null;
    ch.queue.shift();

    this.broadcast(ch, 'turn-completed', {
      channel: ch.name, clientId: entry.clientId, success: false, error: 'LEASE_EXPIRED',
    });
    entry.subscriber?.close();
    entry.subscriber = null;

    metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
    logger.warn('lease expired', { channel: ch.name, clientId: entry.clientId });

    this.grantTurn(ch);
  }

  private expireWait(ch: Channel, entry: QueueEntry) {
    if (ch.active === entry) return; // already holding the turn
    const idx = ch.queue.indexOf(entry);
    if (idx === -1) return;

    entry.waitTimer = null;
    entry.subscriber?.send('timeout', {
      channel: ch.name, requestId: entry.requestId, reason: 'max_wait_exceeded',
    });
    ch.queue.splice(idx, 1);

    for (let i = idx; i < ch.queue.length; i++) {
      ch.queue[i].subscriber?.send('position-updated', {
        channel: ch.name, requestId: ch.queue[i].requestId, position: i + 1,
      });
    }

    entry.subscriber?.close();
    entry.subscriber = null;

    metrics.timeoutsTotal.inc({ channel: ch.name, reason: 'max_wait_exceeded' });
    metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
    logger.info('queue entry evicted: max wait exceeded', { channel: ch.name, clientId: entry.clientId });

    if (idx === 0 && !ch.active) this.grantTurn(ch);
  }

  private releaseTurn(ch: Channel, success: boolean, error?: string) {
    if (!ch.active) return;
    const entry = ch.active;

    if (ch.leaseTimer) { clearTimeout(ch.leaseTimer); ch.leaseTimer = null; }

    if (entry.turnStartedAt !== null) {
      metrics.holdDuration.observe((Date.now() - entry.turnStartedAt) / 1000, { channel: ch.name });
    }

    ch.active = null;
    ch.queue.shift();

    this.broadcast(ch, 'turn-completed', { channel: ch.name, clientId: entry.clientId, success, error });
    entry.subscriber?.close();
    entry.subscriber = null;

    metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
    logger.info('turn released', { channel: ch.name, clientId: entry.clientId, success });

    this.grantTurn(ch);
  }

  private handleWsDisconnect(ch: Channel, entry: QueueEntry) {
    if (ch.active === entry) {
      if (ch.leaseTimer) { clearTimeout(ch.leaseTimer); ch.leaseTimer = null; }
      this.broadcast(ch, 'turn-completed', {
        channel: ch.name, clientId: entry.clientId, success: false, error: 'CLIENT_DISCONNECTED',
      });
      entry.subscriber = null;
      ch.active = null;
      ch.queue.shift();
      metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
      metrics.activeConns.dec({ type: 'ws' });
      logger.info('ws client disconnected (was active)', { channel: ch.name, clientId: entry.clientId });
      this.grantTurn(ch);
    } else {
      const idx = ch.queue.indexOf(entry);
      if (idx !== -1) {
        if (entry.waitTimer) { clearTimeout(entry.waitTimer); entry.waitTimer = null; }
        ch.queue.splice(idx, 1);
        for (let i = idx; i < ch.queue.length; i++) {
          ch.queue[i].subscriber?.send('position-updated', {
            channel: ch.name, requestId: ch.queue[i].requestId, position: i + 1,
          });
        }
        metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
        metrics.activeConns.dec({ type: 'ws' });
        logger.debug('ws client disconnected (was queued)', { channel: ch.name, clientId: entry.clientId });
      }
    }
  }

  private makeWsSubscriber(ws: WebSocket): Subscriber {
    return {
      type: 'ws',
      send(event, data) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
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
      const leaseExpiresAt = Date.now() + ch.leaseMs;
      sub.send('your-turn', { channel: ch.name, requestId: entry.requestId, leaseExpiresAt });
    } else if (idx > 0) {
      sub.send('queued', { channel: ch.name, requestId: entry.requestId, position: idx });
    } else if (idx === 0 && !ch.active) {
      this.grantTurn(ch);
    }
  }

  private setupRoutes() {
    const app = this.app;
    const auth = this.authMiddleware;

    app.get('/health', (_req, res) => {
      res.json({ ok: true, channels: this.channels.size, uptime: process.uptime() });
    });

    app.get('/metrics', auth, (_req, res) => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(metrics.expose());
    });

    app.post('/channels', auth, (req, res) => {
      const { name, leaseMs = 30000, maxDepth, maxWaitMs } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'name required' });
        return;
      }
      if (this.channels.has(name)) {
        res.status(409).json({ code: 'CHANNEL_EXISTS', message: `Channel ${name} already exists` });
        return;
      }
      const ch: Channel = { name, leaseMs, maxDepth, maxWaitMs, queue: [], active: null, leaseTimer: null, observers: new Set() };
      this.channels.set(name, ch);
      this.opts.persist?.save({ name, leaseMs, maxDepth, maxWaitMs });
      metrics.activeChannels.inc();
      metrics.queueDepth.set(0, { channel: name });
      logger.info('channel created', { channel: name, leaseMs, maxDepth, maxWaitMs });
      res.status(201).json({ name, leaseMs, maxDepth, maxWaitMs });
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
      this.opts.persist?.remove(ch.name);
      metrics.activeChannels.dec();
      logger.info('channel deleted', { channel: ch.name });
      res.status(204).end();
    });

    app.get('/channels', auth, (_req, res) => {
      const channels: ChannelInfo[] = [];
      for (const ch of this.channels.values()) {
        channels.push({ name: ch.name, leaseMs: ch.leaseMs, maxDepth: ch.maxDepth, maxWaitMs: ch.maxWaitMs, depth: ch.queue.length, active: ch.active?.clientId ?? null });
      }
      res.json({ channels });
    });

    // Admin: inspect queue for a channel
    app.get('/channels/:name/queue', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      const now = Date.now();
      const queue: QueueEntryInfo[] = ch.queue.map((e, i) => ({
        clientId: e.clientId,
        requestId: e.requestId,
        position: i + 1,
        enqueuedAt: e.enqueuedAt,
        waitingMs: now - e.enqueuedAt,
      }));
      res.json({ channel: ch.name, depth: ch.queue.length, active: ch.active?.clientId ?? null, queue });
    });

    // Admin: force-release the current turn holder
    app.delete('/channels/:name/holder', auth, (req, res) => {
      const ch = this.channels.get(req.params.name);
      if (!ch) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
        return;
      }
      if (!ch.active) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'No active turn holder' });
        return;
      }
      logger.warn('admin force-release', { channel: ch.name, clientId: ch.active.clientId });
      this.releaseTurn(ch, false, 'ADMIN_FORCE_RELEASE');
      res.status(204).end();
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
      if (ch.queue.some((e) => e.clientId === clientId)) {
        res.status(409).json({ code: 'ALREADY_QUEUED', message: 'Client already in queue' });
        return;
      }
      if (ch.maxDepth !== undefined && ch.queue.length >= ch.maxDepth) {
        res.status(429).json({ code: 'MAX_DEPTH_EXCEEDED', message: 'Channel queue is full' });
        return;
      }

      const entry: QueueEntry = {
        clientId,
        requestId: randomUUID(),
        subscriber: null,
        enqueuedAt: Date.now(),
        turnStartedAt: null,
        waitTimer: ch.maxWaitMs ? null : null,
      };

      if (ch.maxWaitMs) {
        entry.waitTimer = setTimeout(() => this.expireWait(ch, entry), ch.maxWaitMs);
      }

      ch.queue.push(entry);
      const position = ch.queue.length - 1;
      metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
      logger.debug('client enqueued', { channel: ch.name, clientId, position });
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
      const entry = this.findEntry(ch, clientId, requestId);
      if (!entry) {
        res.status(404).json({ code: 'CHANNEL_NOT_FOUND', message: 'No matching queue entry' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      metrics.activeConns.inc({ type: 'sse' });
      const sub = this.makeSseSubscriber(res);
      this.attachSubscriber(ch, entry, sub);

      req.on('close', () => {
        metrics.activeConns.dec({ type: 'sse' });
        this.handleWsDisconnect(ch, entry);
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
      this.releaseTurn(ch, result?.success ?? true, result?.error);
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
          if (removed.waitTimer) { clearTimeout(removed.waitTimer); removed.waitTimer = null; }
          removed.subscriber?.close();
          for (let i = idx; i < ch.queue.length; i++) {
            ch.queue[i].subscriber?.send('position-updated', {
              channel: ch.name, requestId: ch.queue[i].requestId, position: i + 1,
            });
          }
          metrics.queueDepth.set(ch.queue.length, { channel: ch.name });
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

  private findEntry(ch: Channel, clientId: string, requestId: string): QueueEntry | null {
    if (ch.active?.clientId === clientId && ch.active?.requestId === requestId) return ch.active;
    return ch.queue.find((e) => e.clientId === clientId && e.requestId === requestId) ?? null;
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
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWsSubscribe(ws, req, subMatch[1]));
      } else if (obsMatch) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWsObserve(ws, req, obsMatch[1]));
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });
  }

  private setupHeartbeat() {
    const intervalMs = this.opts.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.wsAlive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        this.wsAlive.set(ws, false);
        ws.ping();
      }
    }, intervalMs);
  }

  private handleWsSubscribe(ws: WebSocket, req: IncomingMessage, channelName: string) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const clientId = url.searchParams.get('clientId') ?? '';
    const requestId = url.searchParams.get('requestId') ?? '';

    const ch = this.channels.get(channelName);
    if (!ch) { ws.close(1008, 'CHANNEL_NOT_FOUND'); return; }

    const entry = this.findEntry(ch, clientId, requestId);
    if (!entry) { ws.close(1008, 'NO_MATCHING_ENTRY'); return; }

    this.wsAlive.set(ws, true);
    ws.on('pong', () => this.wsAlive.set(ws, true));

    metrics.activeConns.inc({ type: 'ws' });
    const sub = this.makeWsSubscriber(ws);
    this.attachSubscriber(ch, entry, sub);

    ws.on('close', () => this.handleWsDisconnect(ch, entry));
  }

  private handleWsObserve(ws: WebSocket, req: IncomingMessage, channelName: string) {
    const ch = this.channels.get(channelName);
    if (!ch) { ws.close(1008, 'CHANNEL_NOT_FOUND'); return; }

    this.wsAlive.set(ws, true);
    ws.on('pong', () => this.wsAlive.set(ws, true));

    const sub = this.makeWsSubscriber(ws);
    ch.observers.add(sub);
    ws.on('close', () => ch.observers.delete(sub));
  }

  async start(port?: number): Promise<void> {
    const p = port ?? this.opts.port ?? 3000;
    return new Promise((resolve) => {
      this.httpServer.listen(p, () => {
        logger.info('tokn listening', { port: p });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // notify all connected subscribers before closing
    const shutdownPayload = { reason: 'server_shutdown' };
    for (const ch of this.channels.values()) {
      if (ch.leaseTimer) clearTimeout(ch.leaseTimer);
      for (const entry of ch.queue) {
        if (entry.waitTimer) clearTimeout(entry.waitTimer);
        entry.subscriber?.send('server-shutdown', shutdownPayload);
      }
      for (const obs of ch.observers) obs.send('server-shutdown', shutdownPayload);
    }

    // brief window for clients to receive the event
    await new Promise((r) => setTimeout(r, 200));

    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    for (const ch of this.channels.values()) {
      for (const entry of ch.queue) entry.subscriber?.close();
      for (const obs of ch.observers) obs.close();
    }

    for (const client of this.wss.clients) client.terminate();
    this.httpServer.closeAllConnections?.();
    this.wss.close();

    return new Promise((resolve, reject) => {
      if (!this.httpServer.listening) { resolve(); return; }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
