// src/utils/logger.js
// Logger simple con niveles y modo JSON opcional para producción.

import { env } from '../config/env.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT = LEVELS[env.logLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function emit(level, args) {
  if (LEVELS[level] < CURRENT) return;

  if (env.logJson) {
    const [first, ...rest] = args;
    let msg, meta = {};
    if (typeof first === 'string') {
      msg = first;
      if (rest.length === 1 && typeof rest[0] === 'object') meta = rest[0];
      else if (rest.length > 0) meta = { extra: rest };
    } else {
      msg = '';
      meta = { args };
    }
    const line = JSON.stringify({ ts: ts(), level, msg, ...meta });
    const out = level === 'error' ? process.stderr : process.stdout;
    out.write(line + '\n');
    return;
  }

  const prefix = {
    debug: '🔍',
    info: 'ℹ️ ',
    warn: '⚠️ ',
    error: '❌',
  }[level] || '  ';

  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(`[${ts().slice(11, 23)}] ${prefix}`, ...args);
}

export const logger = {
  debug: (...a) => emit('debug', a),
  info:  (...a) => emit('info', a),
  warn:  (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  child: (tag) => ({
    debug: (...a) => emit('debug', [`[${tag}]`, ...a]),
    info:  (...a) => emit('info',  [`[${tag}]`, ...a]),
    warn:  (...a) => emit('warn',  [`[${tag}]`, ...a]),
    error: (...a) => emit('error', [`[${tag}]`, ...a]),
  }),
};

export default logger;
