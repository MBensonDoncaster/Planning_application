import { isApiErrorEnvelope, type ErrorDetail } from '@planning/contracts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export async function errorFromResponse(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(error => {
    if (isAbortError(error)) throw error;
    return undefined;
  });
  if (isApiErrorEnvelope(body)) {
    const { code, message, requestId, details } = body.error;
    return new ApiError(response.status, code, message, requestId || response.headers.get('X-Request-Id') || undefined, details);
  }
  // Proxy HTML, empty responses and malformed error objects are never user messages.
  return new ApiError(response.status, 'REQUEST_FAILED', 'The request could not be completed.', response.headers.get('X-Request-Id') || undefined);
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.requestId && (error.status >= 500 || error.code === 'REQUEST_FAILED')) {
    return `${error.message} Request ID: ${error.requestId}`;
  }
  return error instanceof Error ? error.message : fallback;
}
