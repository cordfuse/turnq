<!-- parent: librarian -->

# turnstile — Claude context

Status: **planning only**. No code scaffolded. The canonical design lives in [PLAN.md](PLAN.md).

## Project

`@cordfuse/turnstile` — named-channel turn coordinator. HTTP + SSE protocol. Bun/TypeScript server, reference TS client, additional languages via examples.

**Near-term driver:** Crosstalk. v1.0 exists to replace `pushWithRetry` / jitter in `cordfuse/crosstalk-runtime`. Other Cordfuse consumers (Politik, future deploy/migration coordinators) may adopt turnstile downstream but don't shape v1.0 scope. If you find a design decision being pulled by a non-Crosstalk requirement, that's the signal to push back.

## What this repo is for right now

Holds the plan-of-record. Implementation has not started. Any code-related work needs to start with the protocol section of `PLAN.md` and align with the build phases.

## Important pointers

- **Source memory** (private, in `steve-krisjanovs/cortex`): `data/memories/20260528T035510.30Z-28a2f8303f2c3165.md` — original execution plan from the cortex session that produced the idea. PLAN.md in this repo supersedes it where they conflict (notably the WebSocket → HTTP+SSE protocol shift and the Crosstalk-only v1.0 scope).
- **Integration consumer (near-term)**: `cordfuse/crosstalk-runtime` — replaces `pushWithRetry`. Drives v1.0.
- **Future consumers** (not driving scope): `cordfuse/politik` (chamber transport, when reference implementation begins) and any other Cordfuse project needing FIFO coordination.
- **License**: MIT.

## Doctrine

- Server is Bun/TypeScript only. No other server implementations planned.
- Client SDKs: TypeScript reference client packaged on npm. Other languages live as runnable examples in `client-examples/` — not packaged SDKs. Community contributes additional languages via the same pattern.
- OpenAPI is complementary, not a replacement for SPEC.md + examples. Defer to v1.1+.
- Don't add WebSocket. The protocol decision is final unless there's a concrete reason to revisit.
