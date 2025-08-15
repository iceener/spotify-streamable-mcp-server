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
    if (!this.shouldLog(level)) return;

    try {
      const lowLevel = (this.server as any)?.server ?? (this.server as any);
      if (lowLevel?.sendLoggingMessage) {
        await lowLevel.sendLoggingMessage({ level, logger: loggerName, data });
      } else if (lowLevel?.notification) {
        await lowLevel.notification({
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
