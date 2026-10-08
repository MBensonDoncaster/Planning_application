import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorMessage, request, requestResponse } from './api';

afterEach(() => { vi.unstubAllGlobals(); });

function respond(body: unknown, status: number, requestId = 'req-123') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
  })));
}

describe('shared browser API client', () => {
  it('retains the nested safe message, code, request ID and validation details', async () => {
    const details = [{ path: 'page', message: 'Use a positive integer.' }];
    respond({ error: { code: 'VALIDATION_ERROR', message: 'Invalid page.', requestId: 'req-body', details } }, 400);
    await expect(request('/admin/users')).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid page.', requestId: 'req-body', details });
  });

  it('includes a request ID when displaying unexpected failures', async () => {
    respond({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.', requestId: 'req-failure' } }, 500);
    const failure = await request('/admin/users').catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(errorMessage(failure, 'Failed')).toBe('The request could not be completed. Request ID: req-failure');
    expect(errorMessage(new ApiError(400, 'VALIDATION_ERROR', 'Invalid request.', 'req-400'), 'Failed')).toBe('Invalid request.');
    expect(errorMessage(undefined, 'Failed')).toBe('Failed');
  });

  it.each([null, [], { error: 'private proxy error' }, { code: 'OLD', message: 'private flat message' }, { error: { code: 1, message: 'private malformed message', requestId: 'r' } }])('uses a safe fallback for a malformed error body: %j', async body => {
    respond(body, 503);
    await expect(request('/home')).rejects.toMatchObject({ status: 503, code: 'REQUEST_FAILED', message: 'The request could not be completed.', requestId: 'req-123' });
  });

  it('handles non-JSON proxy responses without exposing HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private proxy details</html>', { status: 503, headers: { 'X-Request-Id': 'req-proxy' } })));
    await expect(request('/home')).rejects.toMatchObject({ code: 'REQUEST_FAILED', message: 'The request could not be completed.', requestId: 'req-proxy' });
  });

  it('rejects failed download requests before returning a response for file handling', async () => {
    respond({ error: { code: 'NO_EXPORTABLE_GEOMETRY', message: 'No polygons available.', requestId: 'req-export' } }, 422);
    await expect(requestResponse('/call-for-sites/records/export/shapefile', { method: 'POST', body: { ids: ['selected-id'] } })).rejects.toMatchObject({ status: 422, code: 'NO_EXPORTABLE_GEOMETRY', message: 'No polygons available.' });
  });

  it('returns successful JSON and passes cancellation and explicit null bodies to fetch', async () => {
    respond({ status: 'ok' }, 200);
    const controller = new AbortController();
    expect(await request('/home', { method: 'POST', body: null, signal: controller.signal })).toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledWith('/api/v1/home', expect.objectContaining({ signal: controller.signal, body: 'null', headers: { 'Content-Type': 'application/json' } }));
  });

  it('reports unreadable successful JSON as an unexpected response with a request ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'X-Request-Id': 'req-empty' } })));
    const failure = await request('/home').catch(error => error);
    expect(errorMessage(failure, 'Failed')).toBe('The response could not be read. Request ID: req-empty');
  });

  it.each([200, 503])('preserves cancellation while reading a %s response body', async status => {
    const response = new Response('{}', { status });
    vi.spyOn(response, 'json').mockRejectedValueOnce(new DOMException('The request was cancelled.', 'AbortError'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(request('/home')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
