import type { ErrorEnvelope } from '../shared/contract.js';
import {
  HTTP_STATUS_BY_ERROR_CODE,
  type ErrorCode,
  type HttpErrorCodeStatus,
} from '../shared/error-codes.js';

export interface AppErrorOptions {
  cause?: unknown;
  hint?: string;
  status?: HttpErrorCodeStatus;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpErrorCodeStatus;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? HTTP_STATUS_BY_ERROR_CODE[code];
    this.hint = options.hint;
  }
}

export function toErrorEnvelope(
  error: unknown,
  requestId: string,
): { status: HttpErrorCodeStatus; body: ErrorEnvelope } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          hint: error.hint,
        },
        requestId,
      },
    };
  }

  // Unknown internal error: sanitize completely (I5)
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'An internal error occurred. Please contact support with the requestId.',
      },
      requestId,
    },
  };
}
