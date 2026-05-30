# turnq

Named-channel turn coordinator. Exactly one client holds the token at a time. Order is strict FIFO.

Pronounced "token." Two modes: **local** (file lock, no server) and **distributed** (HTTP server, multi-host).

---

## In one sentence

Jitter answers *"is it free?"* — turnq answers *"when is it my turn?"*

---

## Quick start

```typescript
import { createCoordinator } from '@cordfuse/turnq/coordinator';

const coordinator = await createCoordinator();

await coordinator.withTurn('my-channel', async () => {
  // exactly one process is here at a time
});
```

No server, no config. `createCoordinator()` with no arguments uses a local file lock (`flock(2)` via POSIX). Safe across multiple processes on the same host.

---

## Modes

### Local (default)

No server required. Uses `flock(2)` on a temp file — the OS releases the lock automatically if the process dies, so stale locks are impossible.

```typescript
const coordinator = await createCoordinator();
// [turnq] local file lock mode
```

Lock files live at `os.tmpdir()/turnq-locks/<channel>.lock`.

### Distributed

Runs against a turnq HTTP server. Serializes turns across multiple hosts.

```typescript
const coordinator = await createCoordinator({
  url: 'https://turnq.example.com',
  apiKey: process.env.TURNQ_API_KEY,
});
// [turnq] distributed — https://turnq.example.com
```

### Fallback (default: `true`)

If the distributed server is unreachable or credentials are missing, `createCoordinator` falls back to local mode and logs a warning.

```typescript
// default — falls back to local silently
const coordinator = await createCoordinator({
  url: 'https://turnq.example.com',
  apiKey: process.env.TURNQ_API_KEY,
});

// strict — throws if distributed is unavailable
const coordinator = await createCoordinator({
  url: 'https://turnq.example.com',
  apiKey: process.env.TURNQ_API_KEY,
  fallback: false,
});
```

---

## API

### `createCoordinator(opts?)`

```typescript
interface CoordinatorOptions {
  url?: string;       // turnq server URL — omit for local mode
  apiKey?: string;    // required when url is set
  fallback?: boolean; // default: true — fall back to local if distributed unavailable
}

createCoordinator(opts?: CoordinatorOptions): Promise<Coordinator>
```

### `Coordinator`

```typescript
interface Coordinator {
  createChannel(name: string, opts?: { leaseMs?: number }): Promise<void>;
  withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
}
```

`createChannel` is a no-op in local mode. In distributed mode it ensures the channel exists on the server before use.

---

## Direct client usage

For lower-level control, import `TurnqClient` directly:

```typescript
import { TurnqClient } from '@cordfuse/turnq/client';

const client = new TurnqClient('https://turnq.example.com', {
  apiKey: process.env.TURNQ_API_KEY,
});

await client.createChannel('my-channel', { leaseMs: 60_000 });

await client.withTurn('my-channel', async (ctx) => {
  await ctx.withStep('fetch',  () => git.fetch());
  await ctx.withStep('commit', () => git.commit(message, files));
  await ctx.withStep('push',   () => git.push('origin', 'main'));
});

client.close();
```

---

## Running the server

```sh
docker run -e TURNQ_API_KEY=your-key -p 3003:3003 ghcr.io/cordfuse/turnq
```

Or with docker compose from the repo — see `docker-compose.yml`.

### Admin endpoints

```
GET    /health
GET    /metrics                           Prometheus-compatible
GET    /channels/:name/queue              inspect queue
DELETE /channels/:name/holder             force-release current holder
```

---

## Protocol at a glance

WebSocket-first, SSE fallback. HTTP for actions, WSS or SSE for notifications. JSON throughout.

```
POST   /channels                          create channel
POST   /channels/{name}/enqueue           → { requestId, position }
GET    /channels/{name}/subscribe         WSS or SSE stream
POST   /channels/{name}/release           complete turn
POST   /channels/{name}/abort             leave queue
```

Turn lifecycle: **enqueue → subscribe → wait for `your-turn` → do work → release.**

---

## bash + curl

```bash
TURNQ_URL="https://turnq.example.com"
CHANNEL="my-channel"
CLIENT_ID=$(uuidgen)

REQUEST_ID=$(curl -s -X POST "$TURNQ_URL/channels/$CHANNEL/enqueue" \
  -H "x-api-key: $TURNQ_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"clientId\":\"$CLIENT_ID\"}" | jq -r .requestId)

curl -sN "$TURNQ_URL/channels/$CHANNEL/subscribe?clientId=$CLIENT_ID&requestId=$REQUEST_ID" \
  -H "x-api-key: $TURNQ_API_KEY" | while IFS= read -r line; do
  [[ "$line" == "event: your-turn" ]] || continue
  do_work
  curl -s -X POST "$TURNQ_URL/channels/$CHANNEL/release" \
    -H "x-api-key: $TURNQ_API_KEY" \
    -H "content-type: application/json" \
    -d "{\"clientId\":\"$CLIENT_ID\",\"requestId\":\"$REQUEST_ID\"}"
  break
done
```

---

## Go

```go
func withTurn(baseURL, channel, apiKey string, fn func() error) error {
    clientID := newUUID()
    setHeaders := func(r *http.Request) {
        r.Header.Set("x-api-key", apiKey)
        r.Header.Set("content-type", "application/json")
    }

    body, _ := json.Marshal(map[string]string{"clientId": clientID})
    req, _  := http.NewRequest("POST", fmt.Sprintf("%s/channels/%s/enqueue", baseURL, channel), bytes.NewReader(body))
    setHeaders(req)
    resp, _ := http.DefaultClient.Do(req)
    var enq struct{ RequestID string `json:"requestId"` }
    json.NewDecoder(resp.Body).Decode(&enq)
    resp.Body.Close()

    url   := fmt.Sprintf("%s/channels/%s/subscribe?clientId=%s&requestId=%s", baseURL, channel, clientID, enq.RequestID)
    req, _ = http.NewRequest("GET", url, nil)
    req.Header.Set("x-api-key", apiKey)
    resp, _ = http.DefaultClient.Do(req)
    defer resp.Body.Close()

    scanner, currentEvent := bufio.NewScanner(resp.Body), ""
    for scanner.Scan() {
        line := scanner.Text()
        if strings.HasPrefix(line, "event:") { currentEvent = strings.TrimSpace(line[6:]) }
        if strings.HasPrefix(line, "data:") && currentEvent == "your-turn" { break }
    }

    err := fn()

    body, _ = json.Marshal(map[string]any{
        "clientId": clientID, "requestId": enq.RequestID,
        "result": map[string]bool{"success": err == nil},
    })
    req, _ = http.NewRequest("POST", fmt.Sprintf("%s/channels/%s/release", baseURL, channel), bytes.NewReader(body))
    setHeaders(req)
    http.DefaultClient.Do(req)
    return err
}
```

---

## License

MIT.
