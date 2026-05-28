# tokn

When multiple processes need exclusive access to a shared resource — a git branch, a deploy slot, a database migration — the naive fix is retry with jitter: wait a random amount of time, try again, hope for the best. It works until it doesn't. Under load, agents collide repeatedly, waste work they've already done, and latency becomes unpredictable. There's no ordering guarantee, no way to know your position, and no upper bound on how long you might wait.

tokn replaces that gamble with a queue. Clients enqueue on a named channel, receive their turn when they're at the front, do their work, and release. Exactly one client holds the token at a time. Order is strict FIFO. No retries, no conflicts, no tuning magic numbers.

Pronounced "token." The server is resource-agnostic — it knows nothing about git, deploys, or any specific operation. It just enforces turns.

**Status:** Phase 1 complete. See [PLAN.md](PLAN.md) for the full design.

---

## In one sentence

Jitter answers *"is it free?"* — tokn answers *"when is it my turn?"*

## The metaphor

Token ring (1984): only the node holding the token may transmit. `tokn` is the token — it circulates deterministically, one holder at a time, through a hub-and-spoke topology. The hub decides who's next. Spokes wait their turn.

---

## Protocol at a glance

WebSocket-first, SSE fallback. HTTP for actions, WSS or SSE for notifications. JSON throughout. One API key sent as `x-api-key` on every request.

```
GET    /health
POST   /channels                          create channel
POST   /channels/{name}/enqueue           → { requestId, position }
GET    /channels/{name}/subscribe         WSS or SSE stream
POST   /channels/{name}/release           complete turn
POST   /channels/{name}/abort             leave queue
```

The turn lifecycle: **enqueue → subscribe → wait for `your-turn` → do work → release.**

---

## TypeScript (canonical client)

```typescript
import { ToknClient } from '@cordfuse/tokn/client';

const client = new ToknClient('https://tokn.example.com', {
  apiKey: process.env.TOKN_API_KEY,
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

## bash + curl

```bash
TOKN_URL="https://tokn.example.com"
CHANNEL="my-channel"
CLIENT_ID=$(uuidgen)

# Enqueue
REQUEST_ID=$(curl -s -X POST "$TOKN_URL/channels/$CHANNEL/enqueue" \
  -H "x-api-key: $TOKN_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"clientId\":\"$CLIENT_ID\"}" | jq -r .requestId)

# Subscribe — wait for your-turn
curl -sN "$TOKN_URL/channels/$CHANNEL/subscribe?clientId=$CLIENT_ID&requestId=$REQUEST_ID" \
  -H "x-api-key: $TOKN_API_KEY" | while IFS= read -r line; do
  [[ "$line" == "event: your-turn" ]] || continue

  # Do work
  do_work

  # Release
  curl -s -X POST "$TOKN_URL/channels/$CHANNEL/release" \
    -H "x-api-key: $TOKN_API_KEY" \
    -H "content-type: application/json" \
    -d "{\"clientId\":\"$CLIENT_ID\",\"requestId\":\"$REQUEST_ID\"}"
  break
done
```

---

## Python

```python
import httpx, uuid, os

TOKN_URL = "https://tokn.example.com"
CHANNEL  = "my-channel"
headers  = {"x-api-key": os.environ["TOKN_API_KEY"], "content-type": "application/json"}

client_id = str(uuid.uuid4())

# Enqueue
res        = httpx.post(f"{TOKN_URL}/channels/{CHANNEL}/enqueue",
                        headers=headers, json={"clientId": client_id})
request_id = res.json()["requestId"]

# Subscribe — wait for your-turn
with httpx.stream("GET", f"{TOKN_URL}/channels/{CHANNEL}/subscribe",
                  headers=headers,
                  params={"clientId": client_id, "requestId": request_id}) as r:
    event = ""
    for line in r.iter_lines():
        if line.startswith("event:"): event = line[6:].strip()
        elif line.startswith("data:") and event == "your-turn": break

# Do work
do_work()

# Release
httpx.post(f"{TOKN_URL}/channels/{CHANNEL}/release",
           headers=headers, json={"clientId": client_id, "requestId": request_id})
```

---

## Go

```go
package main

import (
    "bufio"
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "strings"
)

func withTurn(baseURL, channel, apiKey string, fn func() error) error {
    clientID := newUUID()
    setHeaders := func(r *http.Request) {
        r.Header.Set("x-api-key", apiKey)
        r.Header.Set("content-type", "application/json")
    }

    // Enqueue
    body, _ := json.Marshal(map[string]string{"clientId": clientID})
    req, _  := http.NewRequest("POST", fmt.Sprintf("%s/channels/%s/enqueue", baseURL, channel), bytes.NewReader(body))
    setHeaders(req)
    resp, _ := http.DefaultClient.Do(req)
    var enq struct{ RequestID string `json:"requestId"` }
    json.NewDecoder(resp.Body).Decode(&enq)
    resp.Body.Close()

    // Subscribe (SSE)
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

    // Do work
    err := fn()

    // Release
    body, _ = json.Marshal(map[string]any{
        "clientId":  clientID,
        "requestId": enq.RequestID,
        "result":    map[string]bool{"success": err == nil},
    })
    req, _ = http.NewRequest("POST", fmt.Sprintf("%s/channels/%s/release", baseURL, channel), bytes.NewReader(body))
    setHeaders(req)
    http.DefaultClient.Do(req)
    return err
}
```

---

## Java

```java
import java.net.http.*;
import java.net.URI;
import java.util.UUID;

var toknUrl  = "https://tokn.example.com";
var channel  = "my-channel";
var apiKey   = System.getenv("TOKN_API_KEY");
var clientId = UUID.randomUUID().toString();
var http     = HttpClient.newHttpClient();

// Enqueue
var enqResp = http.send(
    HttpRequest.newBuilder()
        .POST(HttpRequest.BodyPublishers.ofString("{\"clientId\":\"" + clientId + "\"}"))
        .uri(URI.create(toknUrl + "/channels/" + channel + "/enqueue"))
        .header("x-api-key", apiKey).header("content-type", "application/json")
        .build(),
    HttpResponse.BodyHandlers.ofString());
var requestId = parseRequestId(enqResp.body()); // extract from JSON

// Subscribe (SSE)
var sseResp = http.send(
    HttpRequest.newBuilder()
        .GET()
        .uri(URI.create(toknUrl + "/channels/" + channel +
            "/subscribe?clientId=" + clientId + "&requestId=" + requestId))
        .header("x-api-key", apiKey)
        .build(),
    HttpResponse.BodyHandlers.ofLines());

String currentEvent = "";
for (var line : (Iterable<String>) sseResp.body()::iterator) {
    if (line.startsWith("event:"))           currentEvent = line.substring(6).trim();
    else if (line.startsWith("data:") && "your-turn".equals(currentEvent)) break;
}

// Do work
doWork();

// Release
http.send(
    HttpRequest.newBuilder()
        .POST(HttpRequest.BodyPublishers.ofString(
            "{\"clientId\":\"" + clientId + "\",\"requestId\":\"" + requestId + "\"}"))
        .uri(URI.create(toknUrl + "/channels/" + channel + "/release"))
        .header("x-api-key", apiKey).header("content-type", "application/json")
        .build(),
    HttpResponse.BodyHandlers.discarding());
```

---

## C#

```csharp
using System.Net.Http;
using System.Text;
using System.Text.Json;

var toknUrl  = "https://tokn.example.com";
var channel  = "my-channel";
var clientId = Guid.NewGuid().ToString();
var http     = new HttpClient();
http.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("TOKN_API_KEY"));

// Enqueue
var enqRes = await http.PostAsync(
    $"{toknUrl}/channels/{channel}/enqueue",
    new StringContent($$"""{"clientId":"{{clientId}}"}""", Encoding.UTF8, "application/json"));
var enqJson   = JsonDocument.Parse(await enqRes.Content.ReadAsStringAsync());
var requestId = enqJson.RootElement.GetProperty("requestId").GetString()!;

// Subscribe (SSE)
using var stream = await http.GetStreamAsync(
    $"{toknUrl}/channels/{channel}/subscribe?clientId={clientId}&requestId={requestId}");
using var reader = new StreamReader(stream);

string currentEvent = "", line;
while ((line = await reader.ReadLineAsync() ?? "") != null) {
    if (line.StartsWith("event:"))                                   currentEvent = line[6..].Trim();
    else if (line.StartsWith("data:") && currentEvent == "your-turn") break;
}

// Do work
await DoWorkAsync();

// Release
await http.PostAsync(
    $"{toknUrl}/channels/{channel}/release",
    new StringContent($$"""{"clientId":"{{clientId}}","requestId":"{{requestId}}"}""",
        Encoding.UTF8, "application/json"));
```

---

## Rust

```rust
use reqwest::Client;
use serde_json::{json, Value};
use uuid::Uuid;

async fn with_turn<F, Fut>(base_url: &str, channel: &str, api_key: &str, work: F) -> anyhow::Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let client    = Client::new();
    let client_id = Uuid::new_v4().to_string();

    // Enqueue
    let enq: Value = client
        .post(format!("{base_url}/channels/{channel}/enqueue"))
        .header("x-api-key", api_key)
        .json(&json!({ "clientId": client_id }))
        .send().await?.json().await?;
    let request_id = enq["requestId"].as_str().unwrap().to_owned();

    // Subscribe (SSE)
    let url      = format!("{base_url}/channels/{channel}/subscribe?clientId={client_id}&requestId={request_id}");
    let mut resp = client.get(&url).header("x-api-key", api_key).send().await?;

    let mut current_event = String::new();
    'sse: while let Some(chunk) = resp.chunk().await? {
        for line in std::str::from_utf8(&chunk)?.lines() {
            if let Some(ev) = line.strip_prefix("event:") { current_event = ev.trim().to_owned(); }
            else if line.starts_with("data:") && current_event == "your-turn" { break 'sse; }
        }
    }

    // Do work
    let result = work().await;

    // Release
    client.post(format!("{base_url}/channels/{channel}/release"))
        .header("x-api-key", api_key)
        .json(&json!({
            "clientId":  client_id,
            "requestId": request_id,
            "result": { "success": result.is_ok() }
        }))
        .send().await?;

    result
}
```

---

## PowerShell

```powershell
$ToknUrl  = "https://tokn.example.com"
$Channel  = "my-channel"
$ClientId = [System.Guid]::NewGuid().ToString()
$Headers  = @{ "x-api-key" = $env:TOKN_API_KEY; "Content-Type" = "application/json" }

# Enqueue
$Enq       = Invoke-RestMethod -Method POST -Uri "$ToknUrl/channels/$Channel/enqueue" `
               -Headers $Headers -Body (ConvertTo-Json @{ clientId = $ClientId })
$RequestId = $Enq.requestId

# Subscribe (SSE) — read until your-turn
$Req    = [System.Net.WebRequest]::Create("$ToknUrl/channels/$Channel/subscribe?clientId=$ClientId&requestId=$RequestId")
$Req.Headers["x-api-key"] = $env:TOKN_API_KEY
$Stream = $Req.GetResponse().GetResponseStream()
$Reader = New-Object System.IO.StreamReader($Stream)

$CurrentEvent = ""
while (-not $Reader.EndOfStream) {
    $Line = $Reader.ReadLine()
    if ($Line -match "^event:\s*(.+)")           { $CurrentEvent = $Matches[1] }
    elseif ($Line -match "^data:" -and $CurrentEvent -eq "your-turn") { break }
}
$Reader.Close()

# Do work
Invoke-YourWork

# Release
Invoke-RestMethod -Method POST -Uri "$ToknUrl/channels/$Channel/release" `
    -Headers $Headers `
    -Body (ConvertTo-Json @{ clientId = $ClientId; requestId = $RequestId })
```

---

## License

MIT.
