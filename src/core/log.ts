// Structured JSON-lines logging. Rule: never log note bodies or reminder text,
// only ids, counts and outcomes (information-governance requirement).

export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minLevel: Level = (process.env.BOT_LOG_LEVEL as Level) || 'info'): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
