import { SubmissionValidationError, type SubmissionLimits, validateParsedSubmissionObject, validateSubmissionObject } from '@planning/contracts';
import { AppError } from './errors.js';

export function submissionValidationError(error: unknown): Error {
  if (error instanceof SubmissionValidationError) return new AppError(error.statusCode, error.code, error.message, [{ path: error.path, message: error.message }]);
  return error instanceof Error ? error : new Error('JSON validation failed.');
}
/** One adapter for later human and integration ingestion services. */
export function validateSubmissionBody(body: unknown, limits: Partial<SubmissionLimits> = {}) {
  try { return validateSubmissionObject(body, limits); }
  catch (error) { throw submissionValidationError(error); }
}
/** HTTP bodies already passed installJsonParser's original-byte budget. */
export function validateParsedSubmissionBody(body: unknown, maxDepth?: number) {
  try { return validateParsedSubmissionObject(body, maxDepth); }
  catch (error) { throw submissionValidationError(error); }
}
