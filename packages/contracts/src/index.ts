export * from './application.js';

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: ErrorDetail[];
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!isObject(value) || !isObject(value.error)) return false;
  const { code, message, requestId, details } = value.error;
  return typeof code === 'string' && code.length > 0 &&
    typeof message === 'string' && message.length > 0 && typeof requestId === 'string' &&
    (details === undefined || (Array.isArray(details) && details.every(detail =>
      isObject(detail) && typeof detail.path === 'string' && typeof detail.message === 'string')));
}
