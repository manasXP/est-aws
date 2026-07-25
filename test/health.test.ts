import { describe, it, expect } from 'vitest';
import { matchRoute } from '@aws-blocks/blocks';
import '../aws-blocks/index';
import { dispatchRequest } from './support/dispatch';

// STR-005 — walking-skeleton endpoint: the health check that Release &
// Rollback's post-deploy verification expects per society, served through
// the STR-003-decided RawRoute mechanism.

describe('STR-005 walking-skeleton health endpoint', () => {
  // T-U1
  it('returns the expected payload against the Blocks local runtime', async () => {
    const response = await dispatchRequest('GET', '/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  // T-U2 — the route must be reachable through the registry that
  // `new RawRoute(...)` populates (STR-003's decided mechanism), not a
  // parallel ad-hoc routing path declared some other way.
  it('is registered through the RawRoute registry, not a parallel routing path', () => {
    const matched = matchRoute('GET', '/v1/health');
    expect(matched).not.toBeNull();
    expect(matched?.route.method).toBe('GET');
    expect(matched?.route.path).toBe('/v1/health');
  });
});
