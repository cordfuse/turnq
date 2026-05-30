import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ToknServer } from '../src/server.ts';
import { ToknClient } from '../src/client.ts';

const PORT = 3099;
const API_KEY = 'test-key';
const BASE = `http://localhost:${PORT}`;

let server: ToknServer;

beforeAll(async () => {
  server = new ToknServer({ apiKey: API_KEY, port: PORT });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function authed(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'x-api-key': API_KEY, ...(init?.headers as Record<string, string> | undefined) } };
}

// ── 1. auth ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('missing key → 401', async () => {
    const res = await fetch(`${BASE}/channels`);
    expect(res.status).toBe(401);
  });

  it('wrong key → 401', async () => {
    const res = await fetch(`${BASE}/channels`, { headers: { 'x-api-key': 'bad' } });
    expect(res.status).toBe(401);
  });

  it('correct key → passes', async () => {
    const res = await fetch(`${BASE}/channels`, authed());
    expect(res.status).toBe(200);
  });
});

// ── 3. create channel ──────────────────────────────────────────────────────────

describe('channels CRUD', () => {
  it('create channel → 201', async () => {
    const res = await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test-create', leaseMs: 5000 }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('test-create');
  });

  it('create duplicate → 409', async () => {
    const res = await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test-create' }),
    }));
    expect(res.status).toBe(409);
  });

  it('list channels → includes created channel', async () => {
    const res = await fetch(`${BASE}/channels`, authed());
    const body = await res.json();
    expect(body.channels.some((c: { name: string }) => c.name === 'test-create')).toBe(true);
  });

  it('delete empty channel → 204', async () => {
    const res = await fetch(`${BASE}/channels/test-create`, authed({ method: 'DELETE' }));
    expect(res.status).toBe(204);
  });

  it('delete non-empty channel → 409', async () => {
    // create + enqueue to make it non-empty
    await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test-nonempty', leaseMs: 30000 }),
    }));
    await fetch(`${BASE}/channels/test-nonempty/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'blocker' }),
    }));
    const res = await fetch(`${BASE}/channels/test-nonempty`, authed({ method: 'DELETE' }));
    expect(res.status).toBe(409);
    // cleanup
    await fetch(`${BASE}/channels/test-nonempty/abort`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'blocker' }),
    }));
    await fetch(`${BASE}/channels/test-nonempty`, authed({ method: 'DELETE' }));
  });
});

// ── 4. single client withTurn ─────────────────────────────────────────────────

describe('withTurn', () => {
  it('single client completes successfully', async () => {
    const client = new ToknClient(BASE, { apiKey: API_KEY });
    await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'single-turn', leaseMs: 5000 }),
    }));

    let ran = false;
    await client.withTurn('single-turn', async (_ctx) => {
      ran = true;
    });
    expect(ran).toBe(true);

    await fetch(`${BASE}/channels/single-turn`, authed({ method: 'DELETE' }));
  });
});

// ── 5. FIFO ────────────────────────────────────────────────────────────────────

describe('FIFO ordering', () => {
  it('first enqueued gets turn first, second follows', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fifo-test', leaseMs: 5000 }),
    }));

    const order: number[] = [];
    const c1 = new ToknClient(BASE, { apiKey: API_KEY });
    const c2 = new ToknClient(BASE, { apiKey: API_KEY });

    // Enqueue both before subscribing
    const e1 = await fetch(`${BASE}/channels/fifo-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fifo-c1' }),
    })).then((r) => r.json());

    const e2 = await fetch(`${BASE}/channels/fifo-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fifo-c2' }),
    })).then((r) => r.json());

    // run both concurrently via withTurn using pre-assigned clientIds
    // We use runWithTurnByIds helper via the raw API pattern
    const turn1 = runTurnById(BASE, API_KEY, 'fifo-test', 'fifo-c1', e1.requestId, async () => {
      order.push(1);
      // small delay to ensure ordering is clear
      await new Promise((r) => setTimeout(r, 20));
    });

    const turn2 = runTurnById(BASE, API_KEY, 'fifo-test', 'fifo-c2', e2.requestId, async () => {
      order.push(2);
    });

    await Promise.all([turn1, turn2]);
    expect(order).toEqual([1, 2]);

    await fetch(`${BASE}/channels/fifo-test`, authed({ method: 'DELETE' }));
  });
});

// ── 6. lease expiry ────────────────────────────────────────────────────────────

describe('lease expiry', () => {
  it('next client gets turn after lease expires', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'lease-test', leaseMs: 200 }),
    }));

    // enqueue first client and get turn but never release
    const e1 = await fetch(`${BASE}/channels/lease-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'lease-c1' }),
    })).then((r) => r.json());

    const e2 = await fetch(`${BASE}/channels/lease-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'lease-c2' }),
    })).then((r) => r.json());

    // subscribe c1 via SSE (will get your-turn and just hold it)
    const c1Done = subscribeAndHold(BASE, API_KEY, 'lease-test', 'lease-c1', e1.requestId);

    // subscribe c2 and wait for its turn
    const c2GotTurn = new Promise<boolean>((resolve) => {
      subscribeAndCapture(BASE, API_KEY, 'lease-test', 'lease-c2', e2.requestId).then(resolve);
    });

    // wait for lease to expire + some buffer
    await new Promise((r) => setTimeout(r, 400));

    const got = await c2GotTurn;
    expect(got).toBe(true);

    // release c2
    await fetch(`${BASE}/channels/lease-test/release`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'lease-c2', requestId: e2.requestId }),
    }));

    await c1Done;
    await fetch(`${BASE}/channels/lease-test`, authed({ method: 'DELETE' }));
  });
});

// ── 7. abort from queue ────────────────────────────────────────────────────────

describe('abort', () => {
  it('abort first enqueued, second gets turn', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'abort-test', leaseMs: 5000 }),
    }));

    const e1 = await fetch(`${BASE}/channels/abort-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'abort-c1' }),
    })).then((r) => r.json());

    const e2 = await fetch(`${BASE}/channels/abort-test/enqueue`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'abort-c2' }),
    })).then((r) => r.json());

    // abort c1 (currently active as it was first)
    await fetch(`${BASE}/channels/abort-test/abort`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'abort-c1' }),
    }));

    // c2 should now get turn
    const got = await subscribeAndCapture(BASE, API_KEY, 'abort-test', 'abort-c2', e2.requestId);
    expect(got).toBe(true);

    await fetch(`${BASE}/channels/abort-test/release`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'abort-c2', requestId: e2.requestId }),
    }));

    await fetch(`${BASE}/channels/abort-test`, authed({ method: 'DELETE' }));
  });
});

// ── 8. admin endpoints ────────────────────────────────────────────────────────

describe('admin: GET /channels/:name/queue', () => {
  it('returns queue state', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin-queue-test', leaseMs: 5000 }),
    }));
    await fetch(`${BASE}/channels/admin-queue-test/enqueue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'aq-c1' }),
    }));
    const res = await fetch(`${BASE}/channels/admin-queue-test/queue`, authed());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.depth).toBe(1);
    expect(body.queue[0].clientId).toBe('aq-c1');
    expect(typeof body.queue[0].waitingMs).toBe('number');
    // cleanup
    await fetch(`${BASE}/channels/admin-queue-test/abort`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'aq-c1' }),
    }));
    await fetch(`${BASE}/channels/admin-queue-test`, authed({ method: 'DELETE' }));
  });
});

describe('admin: DELETE /channels/:name/holder', () => {
  it('force-releases active turn, next client gets turn', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'force-release-test', leaseMs: 30000 }),
    }));

    const e1 = await fetch(`${BASE}/channels/force-release-test/enqueue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fr-c1' }),
    })).then((r) => r.json());

    const e2 = await fetch(`${BASE}/channels/force-release-test/enqueue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fr-c2' }),
    })).then((r) => r.json());

    // c1 subscribes and holds
    const c1Done = subscribeAndHold(BASE, API_KEY, 'force-release-test', 'fr-c1', e1.requestId);

    // wait for c1 to be active
    await new Promise((r) => setTimeout(r, 50));

    // admin force-release c1
    const forceRes = await fetch(`${BASE}/channels/force-release-test/holder`, authed({ method: 'DELETE' }));
    expect(forceRes.status).toBe(204);

    // c2 should now get turn
    const got = await subscribeAndCapture(BASE, API_KEY, 'force-release-test', 'fr-c2', e2.requestId);
    expect(got).toBe(true);

    await fetch(`${BASE}/channels/force-release-test/release`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'fr-c2', requestId: e2.requestId }),
    }));

    await c1Done;
    await fetch(`${BASE}/channels/force-release-test`, authed({ method: 'DELETE' }));
  });
});

// ── 9. max wait timeout ────────────────────────────────────────────────────────

describe('maxWaitMs', () => {
  it('client evicted after max wait, receives timeout event', async () => {
    await fetch(`${BASE}/channels`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'maxwait-test', leaseMs: 30000, maxWaitMs: 200 }),
    }));

    // c1 holds the channel
    const e1 = await fetch(`${BASE}/channels/maxwait-test/enqueue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'mw-c1' }),
    })).then((r) => r.json());

    // c2 enqueues and subscribes — should timeout after 200ms
    const e2 = await fetch(`${BASE}/channels/maxwait-test/enqueue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'mw-c2' }),
    })).then((r) => r.json());

    const c1Done = subscribeAndHold(BASE, API_KEY, 'maxwait-test', 'mw-c1', e1.requestId);
    const timedOut = await subscribeAndCaptureTimeout(BASE, API_KEY, 'maxwait-test', 'mw-c2', e2.requestId);
    expect(timedOut).toBe(true);

    await fetch(`${BASE}/channels/maxwait-test/release`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'mw-c1', requestId: e1.requestId }),
    }));

    await c1Done;
    await fetch(`${BASE}/channels/maxwait-test`, authed({ method: 'DELETE' }));
  });
});

// ── 10. metrics endpoint ───────────────────────────────────────────────────────

describe('metrics', () => {
  it('GET /metrics → 200 Prometheus text', async () => {
    const res = await fetch(`${BASE}/metrics`, authed());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('tokn_requests_total');
    expect(text).toContain('tokn_active_channels');
  });

  it('GET /metrics without key → 401', async () => {
    const res = await fetch(`${BASE}/metrics`);
    expect(res.status).toBe(401);
  });
});

// ── 11. health includes uptime ─────────────────────────────────────────────────

describe('health', () => {
  it('GET /health includes uptime', async () => {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });
});

// ── 12. 401 on all /channels endpoints ────────────────────────────────────────

describe('401 on all /channels endpoints without key', () => {
  it('POST /channels → 401', async () => {
    const res = await fetch(`${BASE}/channels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
  it('DELETE /channels/x → 401', async () => {
    const res = await fetch(`${BASE}/channels/x`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
  it('GET /channels → 401', async () => {
    const res = await fetch(`${BASE}/channels`);
    expect(res.status).toBe(401);
  });
  it('POST /channels/x/enqueue → 401', async () => {
    const res = await fetch(`${BASE}/channels/x/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
  it('POST /channels/x/release → 401', async () => {
    const res = await fetch(`${BASE}/channels/x/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function subscribeAndCaptureTimeout(
  base: string,
  apiKey: string,
  channel: string,
  clientId: string,
  requestId: string,
): Promise<boolean> {
  const apiKeyParam = `&apiKey=${encodeURIComponent(apiKey)}`;
  const sseUrl = `${base}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;
  try {
    const res = await fetch(sseUrl, { headers: { 'x-api-key': apiKey } });
    if (!res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:') && currentEvent === 'timeout') return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// ── original helpers ───────────────────────────────────────────────────────────

async function runTurnById(
  base: string,
  apiKey: string,
  channel: string,
  clientId: string,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const headers = { 'x-api-key': apiKey };
  const apiKeyParam = `&apiKey=${encodeURIComponent(apiKey)}`;
  const wsUrl = `ws://localhost:${PORT}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;

  const ws = await connectWs(wsUrl, headers);
  return new Promise((resolve, reject) => {
    ws.on('message', async (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'your-turn') {
        ws.removeAllListeners();
        try {
          await fn();
          await fetch(`${base}/channels/${channel}/release`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, requestId, result: { success: true } }),
          });
          ws.close();
          resolve();
        } catch (e) {
          ws.close();
          reject(e);
        }
      }
    });
    ws.on('error', reject);
  });
}

async function subscribeAndHold(
  base: string,
  apiKey: string,
  channel: string,
  clientId: string,
  requestId: string,
): Promise<void> {
  const apiKeyParam = `&apiKey=${encodeURIComponent(apiKey)}`;
  const sseUrl = `${base}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;
  // SSE: just consume events until closed
  try {
    const res = await fetch(sseUrl, { headers: { 'x-api-key': apiKey } });
    if (!res.body) return;
    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // connection closed by server after expiry — expected
  }
}

async function subscribeAndCapture(
  base: string,
  apiKey: string,
  channel: string,
  clientId: string,
  requestId: string,
): Promise<boolean> {
  const apiKeyParam = `&apiKey=${encodeURIComponent(apiKey)}`;
  const sseUrl = `${base}/channels/${channel}/subscribe?clientId=${clientId}&requestId=${requestId}${apiKeyParam}`;
  try {
    const res = await fetch(sseUrl, { headers: { 'x-api-key': apiKey } });
    if (!res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
        else if (line.startsWith('data:') && currentEvent === 'your-turn') {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

import { WebSocket as WsClient } from 'ws';

function connectWs(url: string, headers: Record<string, string>): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
