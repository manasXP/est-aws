import { describe, it, expect } from 'vitest';
import { db } from '../aws-blocks/index';
import { isManagementAction, handleManagementAction } from '../aws-blocks/management-actions';

// STR-014 — sandbox deploy from CI with ordered pipeline gates (T-U1: no TC
// case covers this repo-tooling behavior, so it's a genuine-gap ID, same
// category as STR-011/012/013's own tooling tests). Direct Lambda Invoke API
// events (never public HTTP) route to deploy-time management actions before
// falling through to normal request handling.

describe('STR-014 management-action routing', () => {
  // T-U1
  it('recognizes only well-formed management action events', () => {
    expect(isManagementAction({ action: 'migrate' })).toBe(true);
    expect(isManagementAction({ action: 'list-applied-migrations' })).toBe(true);
    expect(isManagementAction(undefined)).toBe(false);
    expect(isManagementAction({})).toBe(false);
    expect(isManagementAction({ action: 'other' })).toBe(false);
    expect(isManagementAction(null)).toBe(false);
  });

  it('runs migrations and returns the applied list for a migrate action', async () => {
    const result = await handleManagementAction({ action: 'migrate' }, db);
    expect(Array.isArray((result as { applied: unknown[] }).applied)).toBe(true);
  });

  it('lists applied migration versions for a list-applied-migrations action', async () => {
    await handleManagementAction({ action: 'migrate' }, db);
    const result = await handleManagementAction({ action: 'list-applied-migrations' }, db);
    const { appliedVersions } = result as { appliedVersions: string[] };
    expect(Array.isArray(appliedVersions)).toBe(true);
    expect(appliedVersions.length).toBeGreaterThan(0);
  });

  it('falls through with undefined for a non-management event', async () => {
    const result = await handleManagementAction({ httpMethod: 'GET' }, db);
    expect(result).toBeUndefined();
  });
});
