import { Database } from 'bun:sqlite';
import { logger } from './logger.ts';

export interface PersistedChannel {
  name: string;
  leaseMs: number;
  maxDepth?: number;
  maxWaitMs?: number;
}

export class Persistence {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        name       TEXT    PRIMARY KEY,
        lease_ms   INTEGER NOT NULL DEFAULT 30000,
        max_depth  INTEGER,
        max_wait_ms INTEGER
      )
    `);
    logger.info('persistence ready', { path });
  }

  save(ch: PersistedChannel) {
    this.db.run(
      'INSERT OR REPLACE INTO channels (name, lease_ms, max_depth, max_wait_ms) VALUES (?, ?, ?, ?)',
      [ch.name, ch.leaseMs, ch.maxDepth ?? null, ch.maxWaitMs ?? null],
    );
  }

  remove(name: string) {
    this.db.run('DELETE FROM channels WHERE name = ?', [name]);
  }

  load(): PersistedChannel[] {
    const rows = this.db.query(
      'SELECT name, lease_ms, max_depth, max_wait_ms FROM channels',
    ).all() as Array<{ name: string; lease_ms: number; max_depth: number | null; max_wait_ms: number | null }>;

    return rows.map(r => ({
      name: r.name,
      leaseMs: r.lease_ms,
      ...(r.max_depth   != null ? { maxDepth:  r.max_depth }   : {}),
      ...(r.max_wait_ms != null ? { maxWaitMs: r.max_wait_ms } : {}),
    }));
  }

  close() {
    this.db.close();
  }
}
