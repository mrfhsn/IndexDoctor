export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogMetadata = {
  requestId?: string;
  outcome?: string;
  proposedBy?: string;
  model?: string | null;
  cached?: boolean;
  timingsMs?: Record<string, number>;
  queueDepth?: number;
  workerState?: string;
  respawnCount?: number;
  durationMs?: number;
  statusCode?: number;
  path?: string;
  method?: string;
  error?: string;
  [key: string]: unknown;
};

export class Logger {
  private levelValue: number;

  constructor(level: LogLevel = 'info') {
    this.levelValue = LEVEL_SEVERITY[level] ?? 20;
  }

  setLevel(level: LogLevel): void {
    this.levelValue = LEVEL_SEVERITY[level] ?? 20;
  }

  private write(level: LogLevel, message: string, meta: LogMetadata = {}): void {
    if ((LEVEL_SEVERITY[level] ?? 20) < this.levelValue) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      severity: level.toUpperCase(),
      message,
      ...meta,
    };

    const formatted = JSON.stringify(payload) + '\n';
    if (level === 'error') {
      process.stderr.write(formatted);
    } else {
      process.stdout.write(formatted);
    }
  }

  debug(message: string, meta?: LogMetadata): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.write('error', message, meta);
  }
}

export const logger = new Logger();
