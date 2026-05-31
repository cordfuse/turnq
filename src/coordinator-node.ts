import { TurnqClient } from './client.js';

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

// In-process mutex for Node.js environments (no bun:ffi required).
// Safe for single-process use — each coordinator instance is independent.
class InProcessCoordinator implements Coordinator {
  private readonly locks = new Map<string, Promise<void>>();

  async createChannel(_name: string, _opts?: unknown): Promise<void> {}

  async withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(channel) ?? Promise.resolve();
    let resolve!: () => void;
    this.locks.set(channel, new Promise<void>(r => { resolve = r; }));
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
      if (this.locks.get(channel) !== undefined) {
        // Only delete if no new waiter replaced us
      }
    }
  }

  close(): void {
    this.locks.clear();
  }
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
    console.warn(`[turnq] ${url} unreachable — falling back to in-process lock`);
  } else if (url || apiKey) {
    if (!fallback) throw new Error('[turnq] both url and apiKey required for distributed mode');
    console.warn('[turnq] url or apiKey missing — using in-process lock');
  } else {
    console.log('[turnq] in-process lock mode');
  }

  return new InProcessCoordinator();
}
