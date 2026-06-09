<!-- parent: librarian -->

# turnq — Claude context

Status: **v0.4.0 — SSE-only**. WSS dropped entirely (see Doctrine). See [PLAN.md](PLAN.md) — its WSS-first transport sections are superseded by v0.4.

## Project

`@cordfuse/turnq` — pronounced "token." Named-channel turn coordinator. HTTP actions + SSE notifications. Express/Bun/TypeScript server, TypeScript client. One unified package with subpath exports (`./server`, `./client`).

**Near-term driver:** Crosstalk. turnq exists to reduce git push contention in `cordfuse/crosstalk` (v6 runtime) — and it is **advisory** there: the consumer proceeds without the lock on timeout or error, git arbitrates. Politik is a named future consumer but does not shape scope. If you find a design decision being pulled by a non-Crosstalk requirement, that's the signal to push back.

## What this repo is for right now

Phase 1 is complete (core scaffolded, tests passing). Phase 2 hardening is next. Any code-related work needs to start with the protocol section of `PLAN.md` and align with the build phases.

## Important pointers

- **Source memory** (private, in `steve-krisjanovs/cortex`): `data/memories/20260528T035510.30Z-28a2f8303f2c3165.md` — original execution plan from the cortex session that produced the idea. PLAN.md in this repo supersedes it where they conflict (notably the WebSocket-only → WSS-first/SSE-fallback protocol shift, the Crosstalk-only v1.0 scope, the `turnstile` → `spkr` → `turnq` rename, and the Hono → Express server change).
- **Integration consumer (near-term)**: `cordfuse/crosstalk-runtime` — replaces `pushWithRetry`. Drives v1.0.
- **Named future consumer**: `cordfuse/politik` — chamber write serialization. v1.1+; channel-naming and step taxonomy TBD pending Politik architecture review.
- **License**: MIT.

## Doctrine

- Server is Express/Bun/TypeScript only. No other server implementations planned.
- One unified package `@cordfuse/turnq`. Subpath exports `./server` and `./client`. No split packages.
- **SSE-only since v0.4.0 — do not reintroduce WebSocket.** The subscribe channel is one-directional (server notifies "your-turn"); all client→server actions are plain HTTP POSTs, so duplex bought nothing. Both confirmed 0.3.x bugs lived in the hand-rolled WSS upgrade path (un-decoded %2F params; suspected open-vs-message handshake race that wedged a crosstalk dispatcher). SSE goes through Express routing: auto-decoded params, same auth middleware as every route, no upgrade parsing.
- Client examples: TypeScript (canonical, in `src/client.ts`), curl, Go. No Python.
- OpenAPI is complementary, not a replacement for SPEC.md + examples. Defer to v1.1+.
- The noun *turn* stays — agents take *turns* on channels. `withTurn`, `your-turn`, `turn-completed` all keep "turn" as the unit of work.
- Do not add a separate `@cordfuse/turnq-client` package. One package, subpath exports.
