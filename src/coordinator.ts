import { TurnqClient } from './client.ts';
import { LocalTurnqClient } from './local.ts';

export interface CoordinatorOptions {
  url?: string;
  apiKey?: string;
  fallback?: boolean;
}

export interface Coordinator {
  createChannel(name: string, opts?: { leaseMs?: number }): Promise<void>;
  withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
}

export async function createCoordinator(opts?: CoordinatorOptions): Promise<Coordinator> {
  const { url, apiKey, fallback = true } = opts ?? {};

  if (url && apiKey) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[turnq] distributed — ${url}`);
        return new TurnqClient(url, { apiKey });
      }
    } catch {}
    if (!fallback) throw new Error(`[turnq] ${url} unreachable`);
    console.warn(`[turnq] ${url} unreachable — falling back to local file lock`);
  } else if (url || apiKey) {
    if (!fallback) throw new Error('[turnq] both url and apiKey required for distributed mode');
    console.warn('[turnq] url or apiKey missing — using local file lock');
  } else {
    console.log('[turnq] local file lock mode');
  }

  return new LocalTurnqClient();
}
