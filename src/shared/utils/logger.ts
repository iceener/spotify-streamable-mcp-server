// Simple structured logger for shared modules (works in Node + Workers)
// Does not depend on McpServer - suitable for OAuth flow and other shared code

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

interface LogData {
  message: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatLog(level: LogLevel, logger: string, data: LogData): string {
  const timestamp = new Date().toISOString();
  const { message, ...rest } = data;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `[${timestamp}] ${level.toUpperCase()} [${logger}] ${message}${extra}`;
}

function sanitize(data: LogData): LogData {
  const sanitized = { ...data };
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'access_token',
    'refresh_token',
  ];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
      const value = sanitized[key];
      if (typeof value === 'string' && value.length > 8) {
        sanitized[key] = `${value.substring(0, 8)}...`;
      } else {
        sanitized[key] = '[REDACTED]';
      }
    }
  }

  return sanitized;
}

export const sharedLogger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },

  debug(logger: string, data: LogData): void {
    if (shouldLog('debug')) {
      console.log(formatLog('debug', logger, sanitize(data)));
    }
  },

  info(logger: string, data: LogData): void {
    if (shouldLog('info')) {
      console.log(formatLog('info', logger, sanitize(data)));
    }
  },

  warning(logger: string, data: LogData): void {
    if (shouldLog('warning')) {
      console.warn(formatLog('warning', logger, sanitize(data)));
    }
  },

  error(logger: string, data: LogData): void {
    if (shouldLog('error')) {
      console.error(formatLog('error', logger, sanitize(data)));
    }
  },
};
