import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * MCP logging levels per protocol specification.
 * These map to syslog severity levels.
 */
export type LogLevel =
  | 'debug' // Detailed debug information
  | 'info' // General informational messages
  | 'notice' // Normal but significant events
  | 'warning' // Warning conditions
  | 'error' // Error conditions
  | 'critical' // Critical conditions
  | 'alert' // Action must be taken immediately
  | 'emergency'; // System is unusable

/**
 * Log message payload for notifications/message.
 */
export interface LogMessage {
  /** Logging level (syslog severity) */
  level: LogLevel;
  /** Logger name/source */
  logger: string;
  /** Arbitrary JSON-serializable data */
  data: unknown;
}

/** Numeric severity for level comparison */
const LOG_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

/**
 * Send a log message to MCP client via notifications/message.
 *
 * ⚠️ NODE.JS ONLY - Requires SDK transport for sending notifications.
 * In Workers, logs are console-only (no persistent connection to client).
 *
 * @param server - The MCP server instance
 * @param message - Log message to send
 * @returns true if sent successfully, false otherwise
 */
export async function sendLogToClient(
  server: McpServer,
  message: LogMessage,
): Promise<boolean> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const mcpServer = server as any;
    const lowLevel = mcpServer.server ?? mcpServer;

    // Check if server is connected before sending
    if (!lowLevel?.isConnected?.() && !lowLevel?._transport) {
      return false;
    }

    // The SDK provides sendLoggingMessage on the low-level server
    if (typeof lowLevel?.sendLoggingMessage === 'function') {
      await lowLevel.sendLoggingMessage({
        level: message.level,
        logger: message.logger,
        data: message.data,
      });
      return true;
    }

    // Fallback: try sending notification directly
    if (typeof lowLevel?.notification === 'function') {
      await lowLevel.notification({
        method: 'notifications/message',
        params: message,
      });
      return true;
    }

    return false;
  } catch {
    // Expected during initialization or if client disconnects
    return false;
  }
}

/**
 * Check if client has logging capability enabled.
 */
export function clientSupportsLogging(server: McpServer): boolean {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: accessing private SDK property
    const mcpServer = server as any;
    const lowLevel = mcpServer.server ?? mcpServer;
    const caps = lowLevel?.getClientCapabilities?.();
    return caps?.logging !== undefined;
  } catch {
    return false;
  }
}

/**
 * Sanitize log data by redacting sensitive fields.
 */
function sanitizeLogData(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  const sanitized = { ...(data as Record<string, unknown>) };
  const sensitivePatterns = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'apikey',
    'api_key',
    'credential',
    'private',
  ];

  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();
    if (sensitivePatterns.some((p) => lowerKey.includes(p))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

/**
 * Logger class that sends logs to both console and MCP client.
 * Uses notifications/message per MCP specification.
 */
class Logger {
  private server?: McpServer;
  private currentLevel: LogLevel = 'info';

  setServer(server: McpServer): void {
    this.server = server;
  }

  setLevel(level: string): void {
    if (level in LOG_SEVERITY) {
      this.currentLevel = level as LogLevel;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_SEVERITY[level] >= LOG_SEVERITY[this.currentLevel];
  }

  private async log(level: LogLevel, loggerName: string, data: unknown): Promise<void> {
    if (!this.shouldLog(level)) return;

    const sanitized = sanitizeLogData(data);

    // Send to MCP client if available (Node.js only)
    if (this.server) {
      await sendLogToClient(this.server, {
        level,
        logger: loggerName,
        data: sanitized,
      });
    }

    // Always log to console
    const timestamp = new Date().toISOString();
    const logData =
      typeof sanitized === 'object'
        ? JSON.stringify(sanitized, null, 2)
        : String(sanitized);
    console.log(`[${timestamp}] ${level.toUpperCase()} ${loggerName}: ${logData}`);
  }

  async debug(loggerName: string, data?: unknown): Promise<void> {
    await this.log('debug', loggerName, data ?? {});
  }

  async info(loggerName: string, data?: unknown): Promise<void> {
    await this.log('info', loggerName, data ?? {});
  }

  async notice(loggerName: string, data?: unknown): Promise<void> {
    await this.log('notice', loggerName, data ?? {});
  }

  async warning(loggerName: string, data?: unknown): Promise<void> {
    await this.log('warning', loggerName, data ?? {});
  }

  async error(loggerName: string, data?: unknown): Promise<void> {
    await this.log('error', loggerName, data ?? {});
  }

  async critical(loggerName: string, data?: unknown): Promise<void> {
    await this.log('critical', loggerName, data ?? {});
  }

  async alert(loggerName: string, data?: unknown): Promise<void> {
    await this.log('alert', loggerName, data ?? {});
  }

  async emergency(loggerName: string, data?: unknown): Promise<void> {
    await this.log('emergency', loggerName, data ?? {});
  }
}

export const logger = new Logger();
