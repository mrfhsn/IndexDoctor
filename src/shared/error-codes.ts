import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNSUPPORTED_SQL',
  'RATE_LIMITED',
  'BUSY',
  'NOT_READY',
  'INTERNAL',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export type HttpErrorCodeStatus = 400 | 413 | 415 | 422 | 429 | 500 | 503;

export const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, HttpErrorCodeStatus> = {
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNSUPPORTED_SQL: 422,
  RATE_LIMITED: 429,
  BUSY: 503,
  NOT_READY: 503,
  INTERNAL: 500,
};
