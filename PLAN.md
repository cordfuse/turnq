# Turnstile — Plan

A standalone npm package implementing a **named-channel turn coordinator**. Clients connect over HTTP, join a named channel queue, receive a "your turn" signal via Server-Sent Events, run any arbitrary work locally, report success or failure, and release. The server is resource-agnostic — it knows nothing about git, deploys, or any specific operation.

Built to replace jitter-based push retry in Crosstalk. Generalizes to any FIFO serialization problem across processes or machines.

**Status:** planning. Server is Bun/TS. No code scaffolded yet.
**Near-term driver:** Crosstalk. Other consumers (Politik, deploy queues, migration runners) are future considerations that don't shape v1.0 scope.

---

## Why it matters

- Jitter is probabilistic. Turnstile is deterministic.
- First genuine FIFO cross-process/cross-machine turn coordination as a tiny npm primitive.
- No Redis, no BullMQ, no infrastructure beyond one Node process.
- Generalizes beyond git: deploys, migrations, bulk sends, any serialized operation.
- Dogfooded immediately in Crosstalk to replace the existing `pushWithRetry` / jitter shim — real field validation in a project with active users.

The framing: jitter answers *"is it free?"* — turnstile answers *"when is it my turn?"* Same conceptual model as the 1984 token ring, reimagined as a modern primitive.

---

## Protocol decision: HTTP + SSE (not WebSocket)

The original design specified WebSocket. Revised to HTTP + Server-Sent Events for these reasons:

- **Universal language support.** Every language ships HTTP in its stdlib. WebSocket clients vary in quality and idioms. Drops the multi-language client problem from a maintenance trap to a 30-line wrapper per language.
- **Enterprise survivability.** Corporate proxies are erratic on WebSocket (idle timeouts, SSL inspection, L7 firewalls). HTTPS + SSE works through everything that allows dev workflows.
- **Latency penalty is irrelevant.** WebSocket push ≈ 10 ms. SSE push ≈ 100 ms. Turn coordination operates on second-to-minute work units; the 90 ms is invisible.
- **Disconnect detection via lease/timeout.** WebSocket's automatic disconnect handling was nice, but the lease/timeout pattern already required for hung work also covers client-crash detection. No new mechanism needed.

### Wire-level protocol

Actions are plain HTTP. Notifications are SSE streams. JSON bodies throughout.

```
POST   /channels                          create channel
DELETE /channels/{name}                   delete channel
GET    /channels                          list channels

POST   /channels/{name}/enqueue           → { requestId, position }
GET    /channels/{name}/subscribe         SSE stream — your-turn / queued updates / timeout
POST   /channels/{name}/release           complete your turn
POST   /channels/{name}/abort             abort from queue

POST   /channels/{name}/steps             granular step reporting during a turn (optional)
GET    /channels/{name}/observe           SSE stream — turn-started / turn-completed / step events (read-only)
```

### Server → Client SSE events

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

## Client architecture: reference client + spec + examples

Rather than maintain official SDKs in seven languages, ship one great reference client and let other languages consume the protocol directly.

### Artifacts

- **`client-ts/`** — packaged npm reference client (`@cordfuse/turnstile-client`). Bun-native, Node-compatible. The canonical implementation, with full test suite. Provides the ergonomic `withTurn(channel, async (ctx) => work)` API.
- **`SPEC.md`** — protocol specification. State machine, sequence semantics, error recovery contracts, SSE event schemas. Markdown, human-readable. This is the actual contract.
- **`client-examples/`** — working code in additional languages, demonstrating the protocol in idiomatic form. Not packaged SDKs — just runnable examples. Communities maintain their own; we maintain the pattern.

### Example languages at launch

Initial `client-examples/` directories:

- `curl/` — raw HTTP via bash + curl. Demonstrates the protocol without language opinion.
- `typescript/` (lives as `client-ts/`, the published reference)
- `python/` — async + httpx. Broadest demand outside JS.
- `go/` — idiomatic goroutines + channels. Natural fit for the DevOps audience.

Later additions (`csharp`, `rust`, `java`, `powershell`) come either from Cordfuse or via community contributions. The README explicitly invites contributions with the pattern set by the four launch examples.

### Why not OpenAPI alone?

OpenAPI is great for discrete REST verbs and gets you Swagger UI for free, but:

- SSE streams aren't first-class in OpenAPI tooling.
- Sequence semantics (`enqueue → subscribe → wait → work → release`) can't be expressed.
- Error recovery contracts (what to do on `LEASE_EXPIRED`) need prose somewhere outside the spec.
- Generated SDKs from `openapi-generator-cli` are usually clunky and not idiomatic.

OpenAPI is **complementary**, not a replacement. If/when added, it gets generated from Hono route annotations at near-zero marginal cost. Not a v1.0 priority.

---

## Reference client API (ergonomic surface)

```typescript
import { TurnClient } from '@cordfuse/turnstile-client';

const client = new TurnClient('https://turnstile.example.com');

await client.createChannel('git-push-main', { leaseMs: 60_000 });

await client.withTurn('git-push-main', async (ctx) => {
  await ctx.withStep('fetch',  () => git.fetch());
  await ctx.withStep('commit', () => git.commit(message, files));
  await ctx.withStep('push',   () => git.push('origin', 'main'));
});

client.on('timeout', (channel, reason) => { /* handle revoked turn */ });
client.close();
```

Step reporting is optional — clients that pass `withStep` calls inside `withTurn` get granular audit events on the channel; clients that don't still work.

---

## Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| Client crashes mid-turn | Lease expires, server revokes turn and advances queue. Equivalent to WebSocket disconnect-detection but works for HTTP-only clients. |
| Client crashes mid-queue | Position-update notification stops landing; client just hasn't subscribed anymore. Queue continues. Optional cleanup via TTL on enqueued positions. |
| Work takes too long | Lease timeout fires, turn revoked, queue advances. Active step reporting acts as keepalive. |
| Server restarts | Channel state is in-memory. Clients reconnect, observe via SSE `subscribe` to get current state, re-enqueue if needed. Optional disk persistence for v2. |
| Two clients same clientId in same channel | `ALREADY_QUEUED` error returned to second. |
| Server is SPOF | Run under supervisor (systemd, pm2). Health endpoint for monitoring. Client falls back after configurable timeout. Multi-instance HA is a v2 concern. |

---

## Work atomicity (client responsibility)

The server only guarantees turn ordering. The client's work inside `withTurn` is responsible for its own atomicity. Example: if a client gets `your-turn`, runs `git commit`, then crashes before `git push`, the repo is in a half-done state — the server can't recover that. The README spells this out so adopters don't assume transactional semantics they aren't getting.

---

## Integration target (near-term, drives v1.0)

### Crosstalk (`cordfuse/crosstalk-runtime`)

This is the entire v1.0 driver. Turnstile exists to solve Crosstalk's collision problem first; everything else is downstream.

- Replace `pushWithRetry` shim in `src/git.ts`.
- Replace per-remote push queue in `src/transports/git.ts`.
- Agent startup: connect to turnstile, create/join channels per transport remote.
- `commitAndPush` becomes `withTurn(remote, () => pull + commit + push)`.
- Zero push rejections by design. Retry loop deleted entirely.

---

## Future use cases (not driving v1.0)

Turnstile is designed as a general-purpose FIFO coordination primitive. Beyond Crosstalk, candidate consumers exist — none of which shape current scope:

- **Politik** — write serialization for the speaker pattern in governance proceedings. Will consume turnstile when Politik's reference implementation begins (currently in PLAN phase per `~/Repos/STRATEGY.md`; not happening in turnstile's v1.0 timeframe).
- **Deploy queues** — serializing production deploys across team members or environments.
- **Migration runners** — ensuring database/schema migrations apply one at a time across a fleet.
- **Bulk send coordination** — any process where multiple workers must serialize against a shared resource.

These are illustrative, not commitments. If you find yourself making protocol decisions to accommodate a future use case rather than Crosstalk, push back — the principle is that Crosstalk-shaped requirements drive v1.0 and everything else benefits from the resulting primitive.

---

## Build phases

### Phase 1 — Core package (week 1)

- [ ] `src/server.ts` — `TurnServer` class (create/delete/list channels, enqueue, release, lease/timeout).
- [ ] `src/client.ts` — `TurnClient` (`withTurn`, `createChannel`, `subscribe`, `observe`, reconnect).
- [ ] `src/protocol.ts` — all message types and SSE event types as TypeScript interfaces.
- [ ] `src/errors.ts` — `TurnError` class + error codes.
- [ ] Basic test suite (in-process Hono server, multiple clients, FIFO verification).
- [ ] `SPEC.md` first draft.
- [ ] `README.md` quick-start.

### Phase 2 — Hardening (week 2)

- [ ] Integration tests (lease-expiry mid-turn, reconnect, observer subscription).
- [ ] Dev/prod stack-trace gating.
- [ ] `requestId` correlation across requests.
- [ ] Step reporting end-to-end.
- [ ] Channel observer SSE stream.
- [ ] `templates/systemd/turnstile.service`.
- [ ] `client-examples/curl/`, `client-examples/python/`, `client-examples/go/`.

### Phase 3 — Crosstalk integration (week 3)

- [ ] Replace `pushWithRetry` in `cordfuse/crosstalk-runtime`.
- [ ] Remove jitter config (or deprecate).
- [ ] Update `CROSSTALK.md` session-open step to use turnstile coordination.
- [ ] Field validation: 5 peer agents, 0 push failures over a multi-hour session.

### Phase 4 — Publish (week 4)

- [ ] Final SPEC.md, README.md polish.
- [ ] `npm publish @cordfuse/turnstile-server`.
- [ ] `npm publish @cordfuse/turnstile-client`.
- [ ] GitHub release v1.0.0.
- [ ] Announcement coordinated with Crosstalk's launch wave (target: post-STD-return, alongside the rest of the Cordfuse public push).

---

## Open questions (deferred to implementation phase)

- Channel persistence across server restarts (v2 concern).
- Admin auth for channel create/delete (v2 concern; v1 assumes trusted network).
- What happens to queued clients when a channel is deleted — error out or drain first?
- Multi-instance HA via leader election (v2 concern; v1 assumes single-instance with supervisor restart).
- Politik's specific channel-naming convention and step taxonomy — needs Politik architecture review first.
- OpenAPI spec generation from Hono routes (low-cost add-on after v1.0 if requested).

---

## Genesis

Originated in Cortex dev session 2026-05-26 with dev team actors loaded. Source memory: `data/memories/20260528T035510.30Z-28a2f8303f2c3165.md` in `steve-krisjanovs/cortex`. Original protocol design specified WebSocket; revised to HTTP + SSE during design discussion 2026-05-28.

Insight: jitter answers *"is it free?"* — turnstile answers *"when is it my turn?"* Pattern is analogous to the 1984 token ring, reimagined as a modern npm primitive.
