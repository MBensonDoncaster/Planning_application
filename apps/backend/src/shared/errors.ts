import type { ErrorDetail } from '@planning/contracts';

// Only intentionally safe domain messages/details should be supplied here.
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}
