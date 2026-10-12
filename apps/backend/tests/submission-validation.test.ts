import { describe, expect, it } from 'vitest';
import { parseJsonBytes, parseSubmissionBytes, sourceNumeric, sourceScalarText, sourceTimestamp, SubmissionValidationError, validateSubmissionObject } from '@planning/contracts';

const bytes = (text: string) => new TextEncoder().encode(text);
describe('shared submission object and field validation', () => {
  it('accepts sparse objects and preserves unknown primitives and own prototype-like keys', () => {
    const source = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extension":["é😀",false,12,null]}';
    const result = parseSubmissionBytes(bytes(source));
    expect(JSON.stringify(result.rawJson)).toBe(source);
    expect(Object.hasOwn(result.rawJson, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.rawJson)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(parseSubmissionBytes(bytes('{}')).rawJson).toEqual({});
  });
  it.each(['', ' ', '{', 'null', '[]', '"text"', '42', 'true'])('rejects invalid submission root safely: %j', text => {
    expect(() => parseSubmissionBytes(bytes(text))).toThrow(SubmissionValidationError);
    try { parseSubmissionBytes(bytes(text)); } catch (error) { expect(error).toMatchObject({ statusCode: 400, path: '$' }); }
  });
  it('accepts one UTF-8 BOM and rejects invalid UTF-8 and extra BOM', () => {
    expect(parseSubmissionBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{}')])).rawJson).toEqual({});
    for (const bad of [[0xc3, 0x28], [0xed, 0xa0, 0x80], [0xff], [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...bytes('{}')]]) expect(() => parseSubmissionBytes(new Uint8Array(bad))).toThrow(SubmissionValidationError);
  });
  it('uses inclusive original UTF-8 bytes including multibyte text and BOM', () => {
    const input = bytes('{"text":"é😀"}');
    expect(parseSubmissionBytes(input, { maxBytes: input.length }).rawJson.text).toBe('é😀');
    expect(() => parseSubmissionBytes(input, { maxBytes: input.length - 1 })).toThrow(expect.objectContaining({ statusCode: 413 }));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...input]);
    expect(() => parseSubmissionBytes(withBom, { maxBytes: input.length })).toThrow(expect.objectContaining({ statusCode: 413 }));
    const exponent = bytes('{"n":1e20}');
    expect(parseSubmissionBytes(exponent, { maxBytes: exponent.length }).rawJson.n).toBe(1e20);
  });
  it('accepts 100 container levels and rejects 101 before parsing; brackets inside strings do not count', () => {
    const nested = (levels: number) => '{"child":'.repeat(levels - 1) + '{"text":"[\\"{}]"}' + '}'.repeat(levels - 1);
    expect(() => parseSubmissionBytes(bytes(nested(100)))).not.toThrow();
    expect(() => parseSubmissionBytes(bytes(nested(101)))).toThrow(expect.objectContaining({ statusCode: 400, path: '$' }));
    expect(() => parseSubmissionBytes(bytes('{"items":[{}]}'), { maxDepth: 2 })).toThrow();
  });
  it.each(['{"private-person":"\\u0000"}', '{"private-person":"\\ud800"}', '{"private-person":"\\udc00"}', '{"\\u0000":"ok"}', '{"\\ud800":"ok"}', '{"n":1e999}'])('rejects JSONB-incompatible keys/values without echoing their content: %s', text => {
    try { parseSubmissionBytes(bytes(text)); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(SubmissionValidationError);
      expect(JSON.stringify(error)).not.toContain('private-person');
      expect((error as SubmissionValidationError).path).toBe('$.members[0]');
    }
  });
  it('validates in-memory values without replacing the original source', () => {
    const original = { metadata: { id: false, submittedAt: '2024-02-29T12:00:00+01:00' }, extra: { n: 0 } };
    expect(validateSubmissionObject(original).rawJson).toBe(original);
    expect(original.metadata.submittedAt).toBe('2024-02-29T12:00:00+01:00');
    const circular: Record<string, unknown> = {}; circular.child = circular;
    expect(() => validateSubmissionObject(circular)).toThrow(SubmissionValidationError);
    expect(() => validateSubmissionObject({ bad: undefined })).toThrow(SubmissionValidationError);
  });
  it.each([undefined, null, ''])('maps an absent timestamp to null: %j', value => expect(sourceTimestamp(value)).toBeNull());
  it('normalizes valid leap dates and explicit offsets without modifying source', () => {
    expect(sourceTimestamp('2024-02-29T12:30:10.123+01:30')).toBe('2024-02-29T11:00:10.123Z');
    expect(sourceTimestamp('2026-10-25T01:30:00-01:00')).toBe('2026-10-25T02:30:00.000Z');
  });
  it.each(['0000-01-01T00:00:00Z', '0001-01-01T00:00:00+01:00', '2023-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-01-01', '2026-01-01T12:00:00', '2026-01-01T24:00:00Z', '2026-01-01T12:60:00Z', '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00', ' ', true, {}])('rejects malformed supplied timestamps: %j', value => {
    expect(() => sourceTimestamp(value)).toThrow(expect.objectContaining({ path: 'metadata.submittedAt', statusCode: 400 }));
  });
  it.each([51.5, '51.5', '  +5.15e1  ', '.5', '-.1', '1.'])('accepts complete finite decimal numeric values: %j', value => expect(sourceNumeric(value, 'latitude').value).toBe(Number(value)));
  it.each(['51.5abc', '0x10', 'Infinity', 'NaN', '1e999', true])('rejects unsupported supplied numeric primitives: %j', value => expect(() => sourceNumeric(value, 'known.number')).toThrow(expect.objectContaining({ path: 'known.number' })));
  it.each([undefined, null, '', ' '])('maps absent numeric values to null: %j', value => expect(sourceNumeric(value, 'x').value).toBeNull());
  it('enforces latitude/longitude and areas, while x/y do not infer a CRS', () => {
    const input = { data: { property: { address: { latitude: '-90', longitude: 180, x: 500000, y: -200000 }, boundary: { area: { squareMetres: 0, hectares: '1e2' } } } } };
    expect(validateSubmissionObject(input).rawJson).toBe(input);
    for (const [field, value] of [['latitude', 90.01], ['longitude', -180.01]] as const) {
      expect(() => validateSubmissionObject({ data: { property: { address: { [field]: value } } } })).toThrow(expect.objectContaining({ path: `data.property.address.${field}` }));
    }
    expect(() => validateSubmissionObject({ proposal: { boundary: { area: { hectares: -1 } } } })).toThrow(expect.objectContaining({ path: 'proposal.boundary.area.hectares' }));
  });
  it('an explicit empty canonical section suppresses invalid competing legacy fields', () => {
    expect(() => validateSubmissionObject({ data: { property: {}, proposal: {} }, property: { address: { latitude: 'bad' } }, proposal: { boundary: { area: { hectares: -1 } } } })).not.toThrow();
    expect(() => validateSubmissionObject({ property: { address: { latitude: 'bad' } } })).toThrow(expect.objectContaining({ path: 'property.address.latitude' }));
  });
  it('scalar text preserves strings, number and boolean conversion; structured values warn and remain raw', () => {
    expect(sourceScalarText(false, 'metadata.id')).toEqual({ value: 'false' });
    expect(sourceScalarText(0, 'metadata.id')).toEqual({ value: '0' });
    expect(sourceScalarText('  é  ', 'metadata.id')).toEqual({ value: '  é  ' });
    for (const value of [{ extension: true }, ['answer']]) expect(sourceScalarText(value, 'metadata.id')).toMatchObject({ value: null, warning: { path: 'metadata.id', code: 'UNSUPPORTED_SCALAR' } });
    const structured = { metadata: { id: { extension: true } } };
    expect(validateSubmissionObject(structured).rawJson).toBe(structured);
    const coordinates = { property: { address: { latitude: { unknown: true } } } };
    expect(validateSubmissionObject(coordinates)).toMatchObject({ rawJson: coordinates, warnings: [{ path: 'property.address.latitude', code: 'UNSUPPORTED_SCALAR' }] });
  });
  it('generic JSON parser accepts roots used by other APIs while submission validation requires an object', () => {
    expect(parseJsonBytes(bytes('[1,null]'))).toEqual([1, null]);
  });
});
