import { tmpdir } from 'os';
import { mkdirSync, openSync, closeSync } from 'fs';
import { dlopen, FFIType, ptr } from 'bun:ffi';

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

function buildWindows(): { lock: LockFn; unlock: UnlockFn } {
  // _get_osfhandle: converts a CRT fd to a Win32 HANDLE
  const { symbols: { _get_osfhandle } } = dlopen('msvcrt', {
    _get_osfhandle: { args: [FFIType.i32], returns: FFIType.pointer },
  });

  // OVERLAPPED struct (32 bytes on x64): all zeros = lock from byte 0
  const overlapped = new Uint8Array(32);
  const overlappedPtr = ptr(overlapped);
  const MAXDWORD = 0xffffffff;
  const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;
  const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001;

  const { symbols: { LockFileEx, UnlockFileEx } } = dlopen('kernel32', {
    LockFileEx: {
      args: [FFIType.pointer, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.pointer],
      returns: FFIType.i32,
    },
    UnlockFileEx: {
      args: [FFIType.pointer, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.pointer],
      returns: FFIType.i32,
    },
  });

  return {
    lock: fd => {
      const handle = _get_osfhandle(fd);
      return LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, overlappedPtr) !== 0;
    },
    unlock: fd => {
      const handle = _get_osfhandle(fd);
      UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, overlappedPtr);
    },
  };
}

const { lock: acquireLockOnce, unlock: releaseLock } =
  process.platform === 'win32' ? buildWindows() : buildPosix();

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
