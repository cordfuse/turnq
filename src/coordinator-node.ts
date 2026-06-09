import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, openSync, closeSync, writeSync, statSync, unlinkSync } from 'fs';
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

// Cross-process advisory lock via O_EXCL lockfiles (no bun:ffi, no native
// deps). A lockfile older than STALE_MS is treated as left by a crashed
// process and taken over. The takeover has a small unlink/create race
// window where two processes could both proceed — acceptable: this lock
// is advisory, the consumer's real arbiter (e.g. git push rejection)
// handles the rare double-hold.
const STALE_MS = 30_000;
const POLL_MS = 50;

class LockfileCoordinator implements Coordinator {
  private readonly lockDir: string;

  constructor(lockDir?: string) {
    this.lockDir = lockDir ?? join(tmpdir(), 'turnq-locks');
    mkdirSync(this.lockDir, { recursive: true });
  }

  async createChannel(_name: string, _opts?: unknown): Promise<void> {}

  async withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const lockPath = join(this.lockDir, `${safe}.lock`);

    while (true) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue; // lockfile vanished between open and stat — retry now
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }

    try {
      return await fn();
    } finally {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }

  close(): void {}
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
    console.warn(`[turnq] ${url} unreachable — falling back to local lockfile`);
  } else if (url || apiKey) {
    if (!fallback) throw new Error('[turnq] both url and apiKey required for distributed mode');
    console.warn('[turnq] url or apiKey missing — using local lockfile');
  } else {
    console.log('[turnq] local lockfile mode');
  }

  return new LockfileCoordinator();
}
