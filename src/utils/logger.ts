import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config/env.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

class Logger {
  private server?: McpServer;
  private currentLevel: LogLevel = 'info';

  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3,
  };

  setServer(server: McpServer): void {
    this.server = server;
  }

  setLevel(level: string): void {
    if (this.isValidLevel(level)) {
      this.currentLevel = level as LogLevel;
    }
  }

  private isValidLevel(level: string): level is LogLevel {
    return level in this.levels;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.currentLevel];
  }

  private async log(level: LogLevel, logger: string, data: unknown): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    // Send to MCP client via standard notifications/message if server is available
    try {
      type LowLevel = {
        server?: LowLevel;
        sendLoggingMessage?: (payload: {
          level: LogLevel;
          logger: string;
          data: unknown;
        }) => Promise<void>;
        notification?: (n: { method: string; params: unknown }) => Promise<void>;
      };
      const lowLevel =
        (this.server as unknown as { server?: LowLevel }).server ??
        (this.server as unknown as LowLevel);
      if (typeof lowLevel?.sendLoggingMessage === 'function') {
        await lowLevel.sendLoggingMessage({
          level,
          logger,
          data: this.sanitizeLogData(data),
        });
      } else if (typeof lowLevel?.notification === 'function') {
        await lowLevel.notification({
          method: 'notifications/message',
          params: { level, logger, data: this.sanitizeLogData(data) },
        });
      }
    } catch (_error) {
      // Silently ignore when transport/server is not connected yet
    }

    // Also log to console in non-production for local debugging
    if (config.NODE_ENV !== 'production') {
      const timestamp = new Date().toISOString();
      const logData =
        typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      console.log(`[${timestamp}] ${level.toUpperCase()} ${logger}: ${logData}`);
    }
  }

  private sanitizeLogData(data: unknown): unknown {
    if (typeof data === 'object' && data !== null) {
      const sanitized = { ...(data as Record<string, unknown>) };

      // Remove sensitive fields
      const sensitiveKeys = [
        'password',
        'token',
        'access_token',
        'refresh_token',
        'client_secret',
        'secret',
        'key',
        'authorization',
      ];
      for (const key of sensitiveKeys) {
        if (key in sanitized) {
          sanitized[key] = '[REDACTED]';
        }
      }

      return sanitized;
    }

    return data;
  }

  async debug(logger: string, data?: unknown): Promise<void> {
    await this.log('debug', logger, data ?? {});
  }

  async info(logger: string, data?: unknown): Promise<void> {
    await this.log('info', logger, data ?? {});
  }

  async warning(logger: string, data?: unknown): Promise<void> {
    await this.log('warning', logger, data ?? {});
  }

  async error(logger: string, data?: unknown): Promise<void> {
    await this.log('error', logger, data ?? {});
  }
}

export const logger = new Logger();
