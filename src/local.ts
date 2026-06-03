import { tmpdir } from 'os';
import { mkdirSync, openSync, closeSync } from 'fs';
import { dlopen, FFIType } from 'bun:ffi';

// ---------- platform locking ----------

type LockFn = (fd: number) => boolean;  // true = acquired
type UnlockFn = (fd: number) => void;

function buildPosix(): { lock: LockFn; unlock: UnlockFn } {
  const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
  const libName = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  const { symbols: { flock } } = dlopen(libName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return {
    lock: fd => flock(fd, LOCK_EX | LOCK_NB) === 0,
    unlock: fd => { flock(fd, LOCK_UN); },
  };
}

// Native Windows is not supported. Windows users run inside WSL2, which
// reports as Linux (process.platform === 'linux') and uses the POSIX flock
// path below. A bare win32 process hard-stops here rather than silently
// running unlocked.
if (process.platform === 'win32') {
  throw new Error(
    'Native Windows is not supported. Run inside WSL2 (it is treated as Linux).'
  );
}

const { lock: acquireLockOnce, unlock: releaseLock } = buildPosix();

// ---------- client ----------

export class LocalTurnqClient {
  private lockDir: string;

  constructor(lockDir?: string) {
    this.lockDir = lockDir ?? `${tmpdir()}/turnq-locks`;
    mkdirSync(this.lockDir, { recursive: true });
  }

  async createChannel(_name: string, _opts?: unknown): Promise<void> {}

  async withTurn<T = void>(channel: string, fn: () => Promise<T>): Promise<T> {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fd = openSync(`${this.lockDir}/${safe}.lock`, 'w');
    try {
      await this.acquireLock(fd);
      return await fn();
    } finally {
      releaseLock(fd);
      closeSync(fd);
    }
  }

  private async acquireLock(fd: number): Promise<void> {
    while (true) {
      if (acquireLockOnce(fd)) return;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  close(): void {}
}
