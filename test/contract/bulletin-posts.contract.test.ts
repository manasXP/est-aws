import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import { createBulletinPost } from '../../aws-blocks/communication/bulletin-posts';
import { asAnyStaff, asMember } from '../support/cognito-token';

// STR-132 T-C1 -- the five Admin bulletin-post endpoints against the Admin
// OpenAPI document, dispatched through the real handlers (the
// documents.contract.test.ts pattern).

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function activeMember(name: string): Promise<string> {
  const member = await createMember(db, { name: `${name} ${randomUUID()}` });
  await admitMember(db, member.member_id);
  return member.member_id;
}

async function ecMember(name: string): Promise<string> {
  const memberId = await activeMember(name);
  await assignRole(db, memberId, 'management', '2026-01-01', 'admin-1');
  await assignRole(db, memberId, 'executive_member', '2026-01-01', 'admin-1');
  return memberId;
}

function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

async function societyPostId(ecId: string): Promise<string> {
  const post = await createBulletinPost(db, ecId, {
    scope: 'society',
    title: 'Contract notice',
    body: 'Body of the contract notice.',
  });
  return post.postId;
}

describe('STR-132 T-C1 -- the admin bulletin-post surface conforms to the Admin OpenAPI', () => {
  it('GET /v1/bulletin-posts conforms', async () => {
    const ecId = await ecMember('Contract EC Lister');
    await societyPostId(ecId);

    const response = await dispatchRequest('GET', '/v1/bulletin-posts?scope=all&include_archived=true', {}, await asAnyStaff(db));
    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/bulletin-posts', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('POST /v1/bulletin-posts conforms', async () => {
    const ecId = await ecMember('Contract EC Composer');

    const response = await dispatchRequest(
      'POST',
      '/v1/bulletin-posts',
      { title: 'Contract compose', body: 'Body.', pinned: true },
      { ...(await asMember(db, ecId)) },
    );
    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/bulletin-posts', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('POST /v1/bulletin-posts returns the declared 403 capability_required shape', async () => {
    const atLargeId = await activeMember('Contract Member At Large');

    const response = await dispatchRequest(
      'POST',
      '/v1/bulletin-posts',
      { title: 'Refused', body: 'Body.' },
      { ...(await asMember(db, atLargeId)) },
    );
    expect(response.status).toBe(403);
    const op = await contractTest('admin', '/bulletin-posts', 'post');
    expect(() => op.expectValidResponse(403, response.body)).not.toThrow();
  });

  it('GET /v1/bulletin-posts/{postId} conforms', async () => {
    const ecId = await ecMember('Contract EC Reader');
    const postId = await societyPostId(ecId);

    const response = await dispatchRequest('GET', `/v1/bulletin-posts/${postId}`, {}, await asAnyStaff(db));
    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/bulletin-posts/{postId}', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('PATCH /v1/bulletin-posts/{postId} conforms, and its project-post refusal conforms to the 409', async () => {
    const ecId = await ecMember('Contract EC Editor');
    const postId = await societyPostId(ecId);

    const edit = await dispatchRequest(
      'PATCH',
      `/v1/bulletin-posts/${postId}`,
      { body: 'Amended body.' },
      { ...(await asMember(db, ecId)) },
    );
    expect(edit.status).toBe(200);
    const op = await contractTest('admin', '/bulletin-posts/{postId}', 'patch');
    expect(() => op.expectValidResponse(200, edit.body)).not.toThrow();

    const pcId = await activeMember('Contract PC Member');
    const project = await createProject(db, { name: `Contract Project ${randomUUID()}` });
    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: pcId, member_ids: [pcId] },
      { ownershipLookup: ownershipAmong([[pcId, project.project_id]]) },
    );
    const projectPost = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: project.project_id,
      title: 'PC notice',
      body: 'Body.',
    });

    const refused = await dispatchRequest(
      'PATCH',
      `/v1/bulletin-posts/${projectPost.postId}`,
      { body: 'Admin rewrite.' },
      { ...(await asMember(db, ecId)) },
    );
    expect(refused.status).toBe(409);
    expect(() => op.expectValidResponse(409, refused.body)).not.toThrow();
  });

  it('POST /v1/bulletin-posts/{postId}/archive conforms', async () => {
    const ecId = await ecMember('Contract EC Moderator');
    const postId = await societyPostId(ecId);

    const response = await dispatchRequest(
      'POST',
      `/v1/bulletin-posts/${postId}/archive`,
      {},
      { ...(await asMember(db, ecId)) },
    );
    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/bulletin-posts/{postId}/archive', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('GET /v1/bulletin-posts/{postId} 404s an unknown post in the declared shape', async () => {
    const response = await dispatchRequest('GET', `/v1/bulletin-posts/${randomUUID()}`, {}, await asAnyStaff(db));
    expect(response.status).toBe(404);
    const op = await contractTest('admin', '/bulletin-posts/{postId}', 'get');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });
});
