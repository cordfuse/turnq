import { ToknServer } from './server.ts';
import { Persistence } from './persist.ts';
import { logger } from './logger.ts';

const apiKey = process.env.TOKN_API_KEY;
const port   = parseInt(process.env.PORT ?? '3000', 10);
const persistPath = process.env.PERSIST_PATH;

if (!apiKey) {
  logger.error('TOKN_API_KEY env var required');
  process.exit(1);
}

const persist = persistPath ? new Persistence(persistPath) : undefined;
const server  = new ToknServer({ apiKey, port, persist });

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  await server.stop();
  persist?.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

await server.start();
