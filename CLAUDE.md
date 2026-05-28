<!-- parent: librarian -->

# tokn — Claude context

Status: **planning only**. No code scaffolded. The canonical design lives in [PLAN.md](PLAN.md).

## Project

`@cordfuse/tokn` — pronounced "token." Named-channel turn coordinator. WSS-first/SSE-fallback protocol. Express/Bun/TypeScript server, TypeScript client. One unified package with subpath exports (`./server`, `./client`).

**Near-term driver:** Crosstalk. v1.0 exists to replace `pushWithRetry` / jitter in `cordfuse/crosstalk-runtime`. Politik is a named v1.1+ consumer but does not shape v1.0 scope. If you find a design decision being pulled by a non-Crosstalk requirement, that's the signal to push back.

## What this repo is for right now

Holds the plan-of-record. Implementation has not started. Any code-related work needs to start with the protocol section of `PLAN.md` and align with the build phases.

## Important pointers

- **Source memory** (private, in `steve-krisjanovs/cortex`): `data/memories/20260528T035510.30Z-28a2f8303f2c3165.md` — original execution plan from the cortex session that produced the idea. PLAN.md in this repo supersedes it where they conflict (notably the WebSocket-only → WSS-first/SSE-fallback protocol shift, the Crosstalk-only v1.0 scope, the `turnstile` → `spkr` → `tokn` rename, and the Hono → Express server change).
- **Integration consumer (near-term)**: `cordfuse/crosstalk-runtime` — replaces `pushWithRetry`. Drives v1.0.
- **Named future consumer**: `cordfuse/politik` — chamber write serialization. v1.1+; channel-naming and step taxonomy TBD pending Politik architecture review.
- **License**: MIT.

## Doctrine

- Server is Express/Bun/TypeScript only. No other server implementations planned.
- One unified package `@cordfuse/tokn`. Subpath exports `./server` and `./client`. No split packages.
- Client negotiates WSS first; falls back to SSE automatically. Both connection types supported on the same server endpoint.
- Client examples: TypeScript (canonical, in `src/client.ts`), curl, Go. No Python.
- OpenAPI is complementary, not a replacement for SPEC.md + examples. Defer to v1.1+.
- The noun *turn* stays — agents take *turns* on channels. `withTurn`, `your-turn`, `turn-completed` all keep "turn" as the unit of work.
- Do not add a separate `@cordfuse/tokn-client` package. One package, subpath exports.
