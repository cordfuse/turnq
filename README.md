# tokn

Pronounced "token." A named-channel turn coordinator. Clients join a channel queue, receive their turn, do arbitrary work, release. The server is resource-agnostic — knows nothing about git, deploys, or any specific operation.

Built to replace jitter-based push retry in Crosstalk. Generalizes to any FIFO serialization problem across processes or machines.

**Status:** planning only. No code yet. See [PLAN.md](PLAN.md) for the full design.

---

## In one sentence

Jitter answers *"is it free?"* — tokn answers *"when is it my turn?"*

## The metaphor

Token ring (1984): only the node holding the token may transmit. `tokn` is the token — it circulates deterministically, one holder at a time, through a hub-and-spoke topology. The hub decides who's next. Spokes wait their turn.

## Protocol at a glance

WebSocket-first for low-latency + clean disconnect detection. Automatic SSE fallback for enterprise environments where proxies kill idle WebSocket connections. HTTP for actions, WSS or SSE for notifications. JSON throughout.

One package:

```ts
import { ToknServer } from '@cordfuse/tokn/server';
import { ToknClient } from '@cordfuse/tokn/client';
```

See [PLAN.md](PLAN.md) for the full protocol, error model, failure modes, build phases, and integration targets.

---

## License

MIT.
