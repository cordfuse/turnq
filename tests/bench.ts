import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';
import { TurnqClient } from '../src/client.ts';

const WORKERS   = 20;
const TURNQ_URL  = 'http://localhost:3003';
const API_KEY   = 'test-smoke';
const CHANNEL   = 'bench:push';
const JITTER_MS = 1_000;  // matches real Crosstalk default

function git(cwd: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const p = spawn('git', args, {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    p.on('exit', code => resolve(code ?? 1));
    p.on('error', () => resolve(1));
  });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function makeSetup(label: string): Promise<{ base: string; clones: string[] }> {
  const base = `/tmp/tokn-bench-${label}-${Date.now()}`;
  const remote = join(base, 'remote.git');
  const seed   = join(base, 'seed');

  await mkdir(base, { recursive: true });
  await git('/tmp', ['init', '--bare', '-b', 'main', remote]);

  await mkdir(seed);
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['config', 'user.name', 'bench']);
  await git(seed, ['config', 'user.email', 'bench@local']);
  await writeFile(join(seed, '.gitkeep'), '');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['remote', 'add', 'origin', remote]);
  await git(seed, ['push', '-u', 'origin', 'main']);

  const clones: string[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const dir = join(base, `w${i}`);
    await git(base, ['clone', remote, dir]);
    await git(dir, ['config', 'user.name', `worker-${i}`]);
    await git(dir, ['config', 'user.email', `w${i}@local`]);
    clones.push(dir);
  }

  return { base, clones };
}

async function runJitter(clones: string[]): Promise<{ ms: number; retries: number }> {
  let totalRetries = 0;
  const start = Date.now();

  await Promise.all(clones.map(async (dir, i) => {
    await writeFile(join(dir, `w${i}.txt`), `${i}\n`);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', `bench: worker ${i}`]);

    let retries = 0;
    while (true) {
      await sleep(Math.floor(Math.random() * JITTER_MS));
      const code = await git(dir, ['push', 'origin', 'main']);
      if (code === 0) break;
      retries++;
      await git(dir, ['pull', '--rebase', 'origin', 'main']);
    }
    totalRetries += retries;
  }));

  return { ms: Date.now() - start, retries: totalRetries };
}

async function runTurnq(clones: string[], client: TurnqClient): Promise<{ ms: number }> {
  const start = Date.now();

  await Promise.all(clones.map(async (dir, i) => {
    await new Promise(r => setTimeout(r, i * 20));
    await client.withTurn(CHANNEL, async () => {
      await git(dir, ['pull', '--rebase', 'origin', 'main']);
      await writeFile(join(dir, `w${i}.txt`), `${i}\n`);
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', `bench: worker ${i}`]);
      await git(dir, ['push', 'origin', 'main']);
    }, `bench-w${i}`);
  }));

  return { ms: Date.now() - start };
}

// --- main ---

process.stdout.write(`setting up repos for ${WORKERS} workers...\n`);
const [jitterSetup, toknSetup] = await Promise.all([
  makeSetup('jitter'),
  makeSetup('turnq'))
]);
process.stdout.write(`setup done\n\n`);

process.stdout.write(`--- JITTER (max ${JITTER_MS}ms per retry) ---\n`);
const jitter = await runJitter(jitterSetup.clones);
process.stdout.write(`done: ${(jitter.ms / 1000).toFixed(2)}s — ${jitter.retries} retries\n\n`);

const client = new TurnqClient(TURNQ_URL, { apiKey: API_KEY });
await client.createChannel(CHANNEL, { leaseMs: 60_000 });

process.stdout.write(`--- TURNQ ---\n`);
const turnq = await runTurnq(turnqSetup.clones, client);
process.stdout.write(`done: ${(turnq.ms / 1000).toFixed(2)}s — 0 retries\n\n`);

client.close();
await Promise.all([
  rm(jitterSetup.base, { recursive: true, force: true }),
  rm(turnqSetup.base,   { recursive: true, force: true }),
]);

const speedup = jitter.ms / turnq.ms;
process.stdout.write(`=== RESULT ===\n`);
process.stdout.write(`jitter : ${(jitter.ms / 1000).toFixed(2)}s  (${jitter.retries} retries, ${JITTER_MS}ms max jitter)\n`);
process.stdout.write(`turnq  : ${(turnq.ms / 1000).toFixed(2)}s  (0 retries)\n`);
process.stdout.write(`speedup: ${speedup.toFixed(2)}x\n`);
