import { TurnqClient } from '../src/client.ts';

const TURNQ_URL = 'http://localhost:3003';
const API_KEY  = 'test-smoke';
const CHANNEL  = 'smoke-test';
const N        = 10;

const client = new TurnqClient(TURNQ_URL, { apiKey: API_KEY });
await client.createChannel(CHANNEL, { leaseMs: 30_000 });

const order: number[] = [];
const start = Date.now();

// Stagger enqueue by 20ms so queue order matches worker index.
const workers = Array.from({ length: N }, async (_, i) => {
  await new Promise(r => setTimeout(r, i * 20));
  return client.withTurn(CHANNEL, async () => {
    order.push(i);
    const t = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${t}s] worker ${i} has the token — sleeping 10s`);
    await new Promise(r => setTimeout(r, 10_000));
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] worker ${i} releasing`);
  }, `worker-${i}`);
});

await Promise.all(workers);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\ndone in ${elapsed}s — turn order: [${order.join(', ')}]`);
console.log(order.every((v, i) => v === i) ? 'FIFO: PASS' : 'FIFO: FAIL');
client.close();
