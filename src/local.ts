import { tmpdir } from 'os';
import { mkdirSync, openSync, closeSync } from 'fs';
import { dlopen, FFIType } from 'bun:ffi';

const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;

const libName = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
const { symbols: { flock } } = dlopen(libName, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

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
      flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }

  private async acquireLock(fd: number): Promise<void> {
    while (true) {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) return;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  close(): void {}
}
