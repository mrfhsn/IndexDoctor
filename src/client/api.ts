import {
  diagnoseResponseSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  type DiagnoseRequest,
  type DiagnoseResponse,
  type HealthResponse,
} from '../shared/contract.js';

interface ApiClientErrorDetails {
  status: number;
  code: string;
  message: string;
  hint?: string;
  requestId?: string;
  retryAfterSec?: number;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly hint?: string;
  public readonly requestId?: string;
  public readonly retryAfterSec?: number;

  public constructor(details: ApiClientErrorDetails) {
    super(details.message);
    this.name = 'ApiClientError';
    this.status = details.status;
    this.code = details.code;
    this.hint = details.hint;
    this.requestId = details.requestId;
    this.retryAfterSec = details.retryAfterSec;
  }
}

/**
 * Executes a diagnosis request against the IndexDoctor API.
 * In accordance with Invariant I1, all responses are strictly validated
 * through Zod schemas before being returned to UI components.
 */
export async function diagnose(
  request: DiagnoseRequest,
  signal?: AbortSignal,
): Promise<DiagnoseResponse> {
  let response: Response;

  try {
    response = await fetch('/api/diagnose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiClientError({
        status: 0,
        code: 'ABORTED',
        message: 'Diagnosis was cancelled by the user.',
      });
    }

    const message = err instanceof Error ? err.message : 'Network request failed';
    throw new ApiClientError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: `Failed to connect to IndexDoctor service: ${message}`,
      hint: 'Please check your connection and try again.',
    });
  }

  // Parse Retry-After header if present (e.g. on 429)
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfterSec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new ApiClientError({
      status: response.status,
      code: 'INVALID_JSON',
      message: `Server returned invalid JSON response (${response.status} ${response.statusText}).`,
      retryAfterSec,
    });
  }

  if (!response.ok) {
    const errorParsed = errorEnvelopeSchema.safeParse(rawJson);
    if (errorParsed.success) {
      throw new ApiClientError({
        status: response.status,
        code: errorParsed.data.error.code,
        message: errorParsed.data.error.message,
        hint: errorParsed.data.error.hint,
        requestId: errorParsed.data.requestId,
        retryAfterSec,
      });
    }

    throw new ApiClientError({
      status: response.status,
      code: 'HTTP_ERROR',
      message: `Request failed with status ${response.status}: ${response.statusText}`,
      retryAfterSec,
    });
  }

  const result = diagnoseResponseSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ApiClientError({
      status: 500,
      code: 'CONTRACT_VIOLATION',
      message: 'Server response does not match the expected diagnosis contract.',
      hint: result.error.message,
    });
  }

  return result.data;
}

/**
 * Checks system health and sandbox/LLM readiness.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;

  try {
    response = await fetch('/api/health', { signal });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    throw new ApiClientError({
      status: 0,
      code: 'HEALTH_UNREACHABLE',
      message: `Failed to query health endpoint: ${message}`,
    });
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new ApiClientError({
      status: response.status,
      code: 'INVALID_JSON',
      message: 'Health endpoint returned invalid JSON.',
    });
  }

  const result = healthResponseSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ApiClientError({
      status: response.status,
      code: 'HEALTH_SCHEMA_MISMATCH',
      message: 'Health response does not match schema.',
    });
  }

  return result.data;
}
