# tokn — Plan

Pronounced "token." A standalone npm package implementing a **named-channel turn coordinator**. Clients connect, join a named channel queue, receive a "your turn" signal, run any arbitrary work locally, report success or failure, and release. The server is resource-agnostic — it knows nothing about git, deploys, or any specific operation.

Built to replace jitter-based push retry in Crosstalk. Generalizes to any FIFO serialization problem across processes or machines.

**Status:** planning. Server is Express/Bun/TS. No code scaffolded yet.
**Near-term driver:** Crosstalk. Politik is a named v1.1+ consumer but does not shape v1.0 scope.

---

## The metaphor

Two metaphors compose, and the name captures both:

- **Token ring (1984)** — only the node holding the token may transmit. `tokn` is the token: it circulates deterministically, one holder at a time.
- **Hub-and-spoke** — `tokn` is the hub. Clients are spokes. The hub decides which spoke holds the token next.

The framing: jitter answers *"is it free?"* — `tokn` answers *"when is it my turn?"*

---

## Why it matters

- Jitter is probabilistic. `tokn` is deterministic.
- First genuine FIFO cross-process/cross-machine turn coordination as a tiny npm primitive.
- No Redis, no BullMQ, no infrastructure beyond one Node/Bun process.
- Generalizes beyond git: deploys, migrations, bulk sends, any serialized operation.
- Dogfooded immediately in Crosstalk to replace `pushWithRetry` / jitter shim — real field validation with active users.

---

## Package structure

One package, two subpath exports. Server and client share protocol types at root.

```
@cordfuse/tokn
  imports:
    '@cordfuse/tokn'          → { ToknServer, ToknClient, ...protocol types }
    '@cordfuse/tokn/server'   → { ToknServer }
    '@cordfuse/tokn/client'   → { ToknClient }
```

Single package means one version to pin, one changelog, shared protocol types that can't drift between server and client.

---

## Transport: WSS-first, SSE fallback

The client tries WebSocket first. If the connection fails (corporate proxy, L7 firewall, SSL inspection), it falls back to HTTP + SSE automatically. The server supports both connection types simultaneously.

**Why WSS-first:**
- WebSocket gives ~10 ms push latency vs ~100 ms for SSE polling. Negligible for turn coordination (work units are seconds-to-minutes), but WSS also provides clean disconnect detection without lease polling.
- Most dev environments and direct server connections support WSS fine.

**Why SSE fallback:**
- Corporate proxies kill idle WebSocket connections. HTTPS + SSE survives everything that allows dev workflows.
- Covers the long tail of enterprise and restricted environments.

**Server implementation:** Express server with a `/channels/{name}/subscribe` endpoint that accepts both `Upgrade: websocket` and regular GET requests (SSE).

---

## Wire-level protocol

Actions are plain HTTP POST/DELETE. Notifications arrive over WSS or SSE depending on what the client negotiated.

```
POST   /channels                          create channel
DELETE /channels/{name}                   delete channel
GET    /channels                          list channels

POST   /channels/{name}/enqueue           → { requestId, position }
GET    /channels/{name}/subscribe         WSS or SSE — your-turn / position updates / timeout
POST   /channels/{name}/release           complete your turn
POST   /channels/{name}/abort             abort from queue

POST   /channels/{name}/steps             granular step reporting during a turn (optional)
GET    /channels/{name}/observe           WSS or SSE — turn-started / turn-completed / step events (read-only)
```

### Server → Client events

```
queued           { channel, requestId, position }
your-turn        { channel, requestId, leaseExpiresAt }
position-updated { channel, requestId, position }
timeout          { channel, requestId, reason }
turn-started     { channel, clientId }
turn-completed   { channel, clientId, success, error? }
step-started     { channel, clientId, step }
step-ended       { channel, clientId, step, success, error? }
```

### Error codes

```
CHANNEL_NOT_FOUND
CHANNEL_EXISTS
CHANNEL_NOT_EMPTY
NOT_YOUR_TURN
ALREADY_QUEUED
MAX_DEPTH_EXCEEDED
LEASE_EXPIRED
MALFORMED_REQUEST
INTERNAL_ERROR
```

---

## Client API (ergonomic surface)

```typescript
import { ToknClient } from '@cordfuse/tokn/client';

const client = new ToknClient('https://tokn.example.com');

await client.createChannel('git-push-main', { leaseMs: 60_000 });

await client.withTurn('git-push-main', async (ctx) => {
  await ctx.withStep('fetch',  () => git.fetch());
  await ctx.withStep('commit', () => git.commit(message, files));
  await ctx.withStep('push',   () => git.push('origin', 'main'));
});

client.on('timeout', (channel, reason) => { /* handle revoked turn */ });
client.close();
```

The client negotiates WSS first; falls back to SSE transparently. Step reporting is optional — clients that omit `withStep` still work.

---

## Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| Client crashes mid-turn | WSS: disconnect detected immediately, turn advances. SSE: lease expires, server revokes and advances. |
| Client crashes mid-queue | WSS: removed from queue on disconnect. SSE: position-update stops landing; queue continues. Optional TTL on enqueued positions. |
| Work takes too long | Lease timeout fires, turn revoked, queue advances. Active step reporting acts as keepalive. |
| Server restarts | Channel state is in-memory. Clients reconnect and re-enqueue if needed. Optional disk persistence for v2. |
| Two clients same clientId in same channel | `ALREADY_QUEUED` error returned to second. |
| Server is SPOF | Run under supervisor (systemd, pm2). Health endpoint for monitoring. Client reconnects automatically after configurable backoff. Multi-instance HA is a v2 concern. |

---

## Work atomicity (client responsibility)

The server guarantees turn ordering only. Work inside `withTurn` is responsible for its own atomicity. If a client gets `your-turn`, runs `git commit`, then crashes before `git push`, the repo is half-done — the server cannot recover that. The README spells this out so adopters don't assume transactional semantics they aren't getting.

---

## Integration targets

### Crosstalk (`cordfuse/crosstalk-runtime`) — v1.0 driver

This is the entire v1.0 scope. `tokn` exists to solve Crosstalk's push collision problem.

- Replace `pushWithRetry` shim in `src/git.ts`.
- Replace per-remote push queue in `src/transports/git.ts`.
- Agent startup: connect to `tokn`, create/join channels per transport remote.
- `commitAndPush` becomes `withTurn(remote, () => pull + commit + push)`.
- Zero push rejections by design. Retry loop deleted entirely.

### Politik (`cordfuse/politik`) — v1.1+

Write serialization for chamber proceedings. Each chamber has a channel; agents take turns proposing, seconding, and voting. `tokn` enforces the speaking order. Channel-naming convention and step taxonomy need Politik architecture review before implementation.

---

## Client examples

Rather than maintaining official SDKs, ship one great TypeScript reference client and let other languages consume the protocol directly.

- **`src/client.ts`** — canonical TypeScript client (`@cordfuse/tokn`, subpath `./client`). Bun-native, Node-compatible. WSS-first/SSE-fallback. Full test suite.
- **`SPEC.md`** — protocol specification. State machine, sequence semantics, error recovery contracts, event schemas.
- **`client-examples/curl/`** — raw HTTP + wscat. Demonstrates the protocol without language opinion.
- **`client-examples/go/`** — idiomatic goroutines + channels. Natural fit for the DevOps audience.

Community contributes additional languages via the same pattern.

---

## Build phases

### Phase 1 — Core package (week 1)

- [ ] `src/server.ts` — `ToknServer` class (Express, create/delete/list channels, enqueue, release, lease/timeout, WSS + SSE on same endpoint).
- [ ] `src/client.ts` — `ToknClient` (`withTurn`, `createChannel`, `subscribe`, `observe`, WSS-first/SSE-fallback, reconnect).
- [ ] `src/protocol.ts` — all message types and event types as TypeScript interfaces.
- [ ] `src/errors.ts` — `ToknError` class + error codes.
- [ ] `package.json` subpath exports (`./server`, `./client`).
- [ ] Basic test suite (in-process Express server, multiple clients, FIFO verification).
- [ ] `SPEC.md` first draft.
- [ ] `README.md` quick-start.

### Phase 2 — Hardening (week 2)

- [ ] Integration tests (lease-expiry mid-turn, reconnect on SSE fallback, observer subscription).
- [ ] Dev/prod stack-trace gating.
- [ ] `requestId` correlation across requests.
- [ ] Step reporting end-to-end.
- [ ] Channel observer stream (WSS + SSE).
- [ ] `templates/systemd/tokn.service`.
- [ ] `client-examples/curl/`, `client-examples/go/`.

### Phase 3 — Crosstalk integration (week 3)

- [ ] Replace `pushWithRetry` in `cordfuse/crosstalk-runtime`.
- [ ] Remove jitter config (or deprecate).
- [ ] Update `CROSSTALK.md` session-open step to use `tokn` coordination.
- [ ] Field validation: 5 peer agents, 0 push failures over a multi-hour session.

### Phase 4 — Publish (week 4)

- [ ] Final SPEC.md, README.md polish.
- [ ] `npm publish @cordfuse/tokn`.
- [ ] GitHub release v1.0.0.
- [ ] Announcement coordinated with Crosstalk's launch wave.

---

## Open questions (deferred to implementation phase)

- Channel persistence across server restarts (v2 concern).
- Admin auth for channel create/delete (v2 concern; v1 assumes trusted network).
- What happens to queued clients when a channel is deleted — error out or drain first?
- Multi-instance HA via leader election (v2 concern; v1 assumes single-instance with supervisor restart).
- Politik's channel-naming convention and step taxonomy — needs Politik architecture review first.
- OpenAPI spec (low-cost add-on after v1.0 if requested).

---

## Genesis

Originated in Cortex dev session 2026-05-26 with dev team actors loaded. Source memory: `data/memories/20260528T035510.30Z-28a2f8303f2c3165.md` in `steve-krisjanovs/cortex`. Original codename was `turnstile`; renamed to `spkr` then to `tokn` (2026-05-28) — `tokn` is a web3 respelling of "token," directly referencing the 1984 token ring pattern. Original protocol design specified WebSocket only; revised to WSS-first/SSE-fallback to cover enterprise environments. Server revised from Hono to Express for broader ecosystem compatibility.

Insight: jitter answers *"is it free?"* — `tokn` answers *"when is it my turn?"*
