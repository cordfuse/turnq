type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(entry) + '\n';
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
}

const DEBUG = process.env.LOG_LEVEL === 'debug';

export const logger = {
  info:  (msg: string, fields?: Record<string, unknown>) => emit('info',  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit('warn',  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => { if (DEBUG) emit('debug', msg, fields); },
};
