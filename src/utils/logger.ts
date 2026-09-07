import { env } from '../config/env';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};

type LogLevel = keyof typeof levels;

const currentLevel = levels[env.LOG_LEVEL as LogLevel] ?? levels.info;

const formatMessage = (level: string, message: string, meta?: any) => {
  const timestamp = new Date().toISOString();
  const metaString = meta ? ` | ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaString}`;
};

export const logger = {
  error: (message: string, meta?: any) => {
    if (levels.error <= currentLevel) console.error(formatMessage('error', message, meta));
  },
  warn: (message: string, meta?: any) => {
    if (levels.warn <= currentLevel) console.warn(formatMessage('warn', message, meta));
  },
  info: (message: string, meta?: any) => {
    if (levels.info <= currentLevel) console.info(formatMessage('info', message, meta));
  },
  http: (message: string, meta?: any) => {
    if (levels.http <= currentLevel) console.log(formatMessage('http', message, meta));
  },
  debug: (message: string, meta?: any) => {
    if (levels.debug <= currentLevel) console.debug(formatMessage('debug', message, meta));
  },
};
