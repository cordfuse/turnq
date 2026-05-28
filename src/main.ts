import { ToknServer } from './server.ts';

const apiKey = process.env.TOKN_API_KEY;
const port = parseInt(process.env.PORT ?? '3000', 10);

if (!apiKey) {
  console.error('TOKN_API_KEY env var required');
  process.exit(1);
}

const server = new ToknServer({ apiKey, port });
await server.start();
console.log(`tokn listening on :${port}`);
