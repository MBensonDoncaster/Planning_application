/** JSON-safe source values. Unknown fields and prototype-like own keys are retained. */
export type SourceJson = null | boolean | number | string | SourceJson[] | { [key: string]: SourceJson };
export type SourceObject = { [key: string]: SourceJson };
export interface SubmissionLimits { maxBytes: number; maxDepth: number }
export const DEFAULT_SUBMISSION_LIMITS: Readonly<SubmissionLimits> = { maxBytes: 10_485_760, maxDepth: 100 };
export interface ExtractionWarning { path: string; code: 'UNSUPPORTED_SCALAR'; message: string }

export class SubmissionValidationError extends Error {
  readonly code: 'VALIDATION_ERROR' | 'PAYLOAD_TOO_LARGE';
  constructor(public readonly statusCode: 400 | 413, public readonly path: string, message: string) {
    super(message);
    this.name = 'SubmissionValidationError';
    this.code = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
  }
}
function invalid(path: string, message: string): never { throw new SubmissionValidationError(400, path, message); }
function limitsWithDefaults(limits: Partial<SubmissionLimits>): SubmissionLimits {
  const resolved = { ...DEFAULT_SUBMISSION_LIMITS, ...limits };
  if (![resolved.maxBytes, resolved.maxDepth].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Use positive integer validation limits.');
  return resolved;
}
function validateString(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) invalid(path, 'NUL characters cannot be stored in JSON.');
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(path, 'Use valid Unicode characters.');
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid(path, 'Use valid Unicode characters.');
  }
}
/** Unknown key names may contain private information; paths use member indices. */
export function validateSourceJson(value: unknown, maxDepth = DEFAULT_SUBMISSION_LIMITS.maxDepth): asserts value is SourceJson {
  limitsWithDefaults({ maxDepth });
  const active = new Set<object>();
  function visit(item: unknown, depth: number, path: string): void {
    if (typeof item === 'string') { validateString(item, path); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(path, 'Use a finite number.'); return; }
    if (typeof item !== 'object' || item === null) invalid(path, 'Use a JSON value.');
    if (depth > maxDepth) invalid('$', 'JSON nesting exceeds the permitted limit.');
    if (active.has(item)) invalid('$', 'Use JSON without circular references.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid(path, 'Use a JSON object.');
    active.add(item);
    Object.entries(item).forEach(([key, child], index) => {
      const childPath = Array.isArray(item) ? `${path}[${index}]` : `${path}.members[${index}]`;
      validateString(key, childPath);
      visit(child, depth + 1, childPath);
    });
    active.delete(item);
  }
  visit(value, 1, '$');
}
export function parseJsonBytes(bytes: Uint8Array, limits: Partial<SubmissionLimits> = {}): SourceJson {
  const { maxBytes, maxDepth } = limitsWithDefaults(limits);
  if (bytes.byteLength > maxBytes) throw new SubmissionValidationError(413, '$', 'JSON exceeds the permitted byte limit.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return invalid('$', 'Use valid UTF-8 JSON.'); }
  // TextDecoder consumes one optional leading UTF-8 BOM. Count containers before
  // JSON.parse so hostile nesting cannot reach recursive validation or consumers.
  let quoted = false; let escaped = false; let depth = 0;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > maxDepth) invalid('$', 'JSON nesting exceeds the permitted limit.');
    } else if (character === '}' || character === ']') depth--;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return invalid('$', 'Supply valid JSON.'); }
  validateSourceJson(value, maxDepth);
  return value;
}
function object(value: unknown): value is SourceObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value: SourceObject | undefined, key: string): SourceJson | undefined { return value && Object.hasOwn(value, key) ? value[key] : undefined; }
function child(value: SourceObject | undefined, key: string): SourceObject | undefined { const result = own(value, key); return object(result) ? result : undefined; }
function unsupported(path: string): ExtractionWarning { return { path, code: 'UNSUPPORTED_SCALAR', message: 'The structured value is preserved in source JSON and cannot populate this scalar field.' }; }
export function sourceScalarText(value: SourceJson | undefined, path: string): { value: string | null; warning?: ExtractionWarning } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value === 'object') return { value: null, warning: unsupported(path) };
  return { value: String(value) };
}
export function sourceNumeric(value: SourceJson | undefined, path: string, range: { min?: number; max?: number } = {}): { value: number | null; warning?: ExtractionWarning } {
  if (value === undefined || value === null || value === '' || (typeof value === 'string' && value.trim() === '')) return { value: null };
  if (typeof value === 'object') return { value: null, warning: unsupported(path) };
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) invalid(path, 'Use a complete finite numeric value.');
  const result = Number(value);
  if (!Number.isFinite(result)) invalid(path, 'Use a finite numeric value.');
  if ((range.min !== undefined && result < range.min) || (range.max !== undefined && result > range.max)) invalid(path, 'The numeric value is outside the permitted range.');
  return { value: result };
}
export function sourceTimestamp(value: SourceJson | undefined, path = 'metadata.submittedAt'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') invalid(path, 'Use an ISO timestamp with Z or an explicit offset.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid(path, 'Use an ISO timestamp with Z or an explicit offset.');
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || Number(match[10] ?? 0) > 23 || Number(match[11] ?? 0) > 59) invalid(path, 'Use a valid calendar date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) invalid(path, 'Use a valid calendar date and time.');
  return date.toISOString();
}
function checkSubmissionObject(value: unknown, limits: Partial<SubmissionLimits>, checkBytes: boolean): { rawJson: SourceObject; warnings: ExtractionWarning[] } {
  const resolved = limitsWithDefaults(limits);
  if (!object(value)) invalid('$', 'Supply one JSON object.');
  validateSourceJson(value, resolved.maxDepth);
  if (checkBytes && new TextEncoder().encode(JSON.stringify(value)).byteLength > resolved.maxBytes) throw new SubmissionValidationError(413, '$', 'JSON exceeds the permitted byte limit.');
  sourceTimestamp(own(child(value, 'metadata'), 'submittedAt'));
  const warnings: ExtractionWarning[] = [];
  const data = child(value, 'data');
  for (const section of ['property', 'proposal']) {
    const canonical = child(data, section);
    const selected = canonical ?? child(value, section);
    const base = canonical ? `data.${section}` : section;
    if (section === 'property') {
      const address = child(selected, 'address');
      for (const field of ['latitude', 'longitude', 'x', 'y']) {
        const result = sourceNumeric(own(address, field), `${base}.address.${field}`, field === 'latitude' ? { min: -90, max: 90 } : field === 'longitude' ? { min: -180, max: 180 } : {});
        if (result.warning) warnings.push(result.warning);
      }
    }
    const area = child(child(selected, 'boundary'), 'area');
    for (const field of ['squareMetres', 'hectares']) {
      const result = sourceNumeric(own(area, field), `${base}.boundary.area.${field}`, { min: 0 });
      if (result.warning) warnings.push(result.warning);
    }
  }
  return { rawJson: value, warnings };
}
export function validateSubmissionObject(value: unknown, limits: Partial<SubmissionLimits> = {}): { rawJson: SourceObject; warnings: ExtractionWarning[] } {
  return checkSubmissionObject(value, limits, true);
}
/** For values from parseJsonBytes only: the original byte budget is already checked. */
export function validateParsedSubmissionObject(value: unknown, maxDepth = DEFAULT_SUBMISSION_LIMITS.maxDepth): { rawJson: SourceObject; warnings: ExtractionWarning[] } {
  return checkSubmissionObject(value, { maxDepth }, false);
}
export function parseSubmissionBytes(bytes: Uint8Array, limits: Partial<SubmissionLimits> = {}): { rawJson: SourceObject; warnings: ExtractionWarning[] } {
  // Use the original encoded length; re-serialization can expand number notation.
  return checkSubmissionObject(parseJsonBytes(bytes, limits), limits, false);
}
