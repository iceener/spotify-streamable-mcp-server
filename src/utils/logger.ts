import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

  private async log(level: LogLevel, loggerName: string, data: unknown): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    try {
      const lowLevel =
        (
          this.server as
            | {
                server?: {
                  sendLoggingMessage?: unknown;
                  notification?: unknown;
                };
              }
            | undefined
        )?.server ?? this.server;
      const sendLoggingMessage = (
        lowLevel as {
          sendLoggingMessage?: (payload: {
            level: LogLevel;
            logger: string;
            data: unknown;
          }) => Promise<void> | void;
        }
      )?.sendLoggingMessage;
      if (typeof sendLoggingMessage === 'function') {
        await sendLoggingMessage({ level, logger: loggerName, data });
        return;
      }

      const notify = (
        lowLevel as {
          notification?: (payload: {
            method: string;
            params: { level: LogLevel; logger: string; data: unknown };
          }) => Promise<void> | void;
        }
      )?.notification;
      if (typeof notify === 'function') {
        await notify({
          method: 'notifications/message',
          params: { level, logger: loggerName, data },
        });
      }
    } catch {}

    const timestamp = new Date().toISOString();
    const payload = typeof data === 'object' ? JSON.stringify(data) : String(data);
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] ${level.toUpperCase()} ${loggerName}: ${payload}`);
  }

  async debug(loggerName: string, data?: unknown): Promise<void> {
    await this.log('debug', loggerName, data ?? {});
  }
  async info(loggerName: string, data?: unknown): Promise<void> {
    await this.log('info', loggerName, data ?? {});
  }
  async warning(loggerName: string, data?: unknown): Promise<void> {
    await this.log('warning', loggerName, data ?? {});
  }
  async error(loggerName: string, data?: unknown): Promise<void> {
    await this.log('error', loggerName, data ?? {});
  }
}

export const logger = new Logger();
