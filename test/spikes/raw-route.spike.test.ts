import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchRequest, registerSpikeRoute } from './raw-route-helper';

// STR-003 Q1: can the IFC layer expose a plain HTTP route consumable by a
// generic (non-TypeScript) HTTP client, without the CDK escape hatch?
// T-U1: a spike route responds to a plain HTTP request in the local runtime.

describe('STR-003 Q1 — Blocks native HTTP routes', () => {
  beforeEach(() => {
    registerSpikeRoute();
  });

  it('responds to a plain HTTP request in the local runtime', async () => {
    const response = await dispatchRequest('GET', '/str-003-spike/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('extracts named path parameters, proving real routing (not just an exact-match stub)', async () => {
    const response = await dispatchRequest('GET', '/str-003-spike/echo/abc-123');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'abc-123' });
  });

  it('reports 404 for a path no route declares', async () => {
    const response = await dispatchRequest('GET', '/str-003-spike/does-not-exist');
    expect(response.status).toBe(404);
  });
});
