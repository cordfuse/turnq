import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, openSync, closeSync, writeSync, statSync, unlinkSync, readFileSync } from 'fs';
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
// deps). Staleness is pid-based: the lockfile holds the holder's pid, and
// a dead holder (ESRCH) is taken over after one poll; the mtime check is
// only a backstop for unreadable pids. The takeover has a small
// unlink/create race window where two processes could both proceed —
// acceptable: this lock is advisory, the consumer's real arbiter (e.g.
// git push rejection) handles the rare double-hold.
const STALE_MS = 30_000;
const POLL_MS = 50;
// A releaser can re-acquire synchronously while waiters sleep in their
// polls, letting one busy process drain its whole queue and starve
// everyone else into timeout (observed in the crosstalk Monte Carlo).
// Jittered polls plus a post-release cooldown before re-locking the same
// channel keep acquisition roughly interleaved.
const RELOCK_COOLDOWN_MS = 2 * POLL_MS;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class LockfileCoordinator implements Coordinator {
  private readonly lockDir: string;
  private readonly lastRelease = new Map<string, number>();

  constructor(lockDir?: string) {
    this.lockDir = lockDir ?? join(tmpdir(), 'turnq-locks');
    mkdirSync(this.lockDir, { recursive: true });
  }

  async createChannel(_name: string, _opts?: unknown): Promise<void> {}

  async withTurn<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const lockPath = join(this.lockDir, `${safe}.lock`);

    const cooldown = (this.lastRelease.get(safe) ?? 0) + RELOCK_COOLDOWN_MS - Date.now();
    if (cooldown > 0) await new Promise((r) => setTimeout(r, cooldown));

    while (true) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch {
        let stale = false;
        try {
          const raw = readFileSync(lockPath, 'utf-8').trim();
          const holderPid = Number(raw);
          if (Number.isInteger(holderPid) && holderPid > 0) {
            stale = !pidAlive(holderPid);
          } else {
            stale = Date.now() - statSync(lockPath).mtimeMs > STALE_MS;
          }
        } catch {
          continue; // lockfile vanished between open and read — retry now
        }
        if (stale) {
          try { unlinkSync(lockPath); } catch { /* another waiter got it */ }
          continue;
        }
        const jitter = POLL_MS / 2 + Math.random() * POLL_MS;
        await new Promise((r) => setTimeout(r, jitter));
      }
    }

    try {
      return await fn();
    } finally {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
      this.lastRelease.set(safe, Date.now());
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
