# spkr

Pronounced "speaker." A named-channel turn coordinator. Clients join a channel queue, receive their turn, do arbitrary work, release. The server is resource-agnostic — knows nothing about git, deploys, or any specific operation.

Built to replace jitter-based push retry in Crosstalk. Generalizes to any FIFO serialization problem across processes or machines.

**Status:** planning only. No code yet. Near-term scope is Crosstalk; other use cases (Politik, deploy queues, migrations) are downstream beneficiaries. See [PLAN.md](PLAN.md) for the full design.

---

## In one sentence

Jitter answers *"is it free?"* — spkr answers *"when is it my turn?"*

## The metaphor

`spkr` is the hub. Clients are spokes. The hub is also the speaker in a parliamentary sense — grants the floor, maintains order, and never speaks out of turn themselves. Both metaphors describe the same architecture from different angles.

## Protocol at a glance

HTTP for actions, Server-Sent Events for notifications. JSON throughout. The server is Bun/TypeScript; clients in any language that speaks HTTP.

See [PLAN.md](PLAN.md) for the full protocol, error model, failure modes, build phases, and integration targets.

---

## License

MIT.
