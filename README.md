# turnstile

A named-channel turn coordinator. Clients join a channel queue, receive their turn, do arbitrary work, release. The server is resource-agnostic — knows nothing about git, deploys, or any specific operation.

Built to replace jitter-based push retry in Crosstalk and to provide the chamber-transport primitive for Politik. Generalizes to any FIFO serialization problem across processes or machines.

**Status:** planning only. No code yet. See [PLAN.md](PLAN.md) for the full design.

---

## In one sentence

Jitter answers *"is it free?"* — turnstile answers *"when is it my turn?"*

## Protocol at a glance

HTTP for actions, Server-Sent Events for notifications. JSON throughout. The server is Bun/TypeScript; clients in any language that speaks HTTP.

See [PLAN.md](PLAN.md) for the full protocol, error model, failure modes, build phases, and integration targets.

---

## License

MIT.
