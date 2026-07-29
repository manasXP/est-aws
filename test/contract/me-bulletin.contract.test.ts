import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { createBulletinPost } from '../../aws-blocks/communication/bulletin-posts';
import { asAnyStaff, asMember } from '../support/cognito-token';

// STR-133 T-C1 (BE-C, covers TC-COM-002) — the three mobile bulletin
// endpoints against the Mobile OpenAPI document, dispatched through the real
// handlers (the test/contract/bulletin-posts.contract.test.ts pattern).

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

async function projectWithOwner(memberId: string): Promise<string> {
  const project = await createProject(db, { name: `Contract Project ${randomUUID()}` });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
  await createOwnership(db, memberId, { asset_id: asset.asset_id });
  return project.project_id;
}

/** Registers a project-level document and lands its bytes in the bucket, so
 * the presigned download has a real object behind it (the STR-111 lazy
 * checksum gate). */
async function attachableDocument(projectId: string): Promise<string> {
  const response = await dispatchRequest(
    'POST',
    '/v1/documents',
    {
      level: 'project',
      project_id: projectId,
      title: 'Lift AMC circular',
      category: 'Correspondence',
      filename: 'circular.pdf',
      content_type: 'application/pdf',
    },
    await asAnyStaff(db),
  );
  const documentId = (response.body as { document_id: string }).document_id;
  const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
  await documents.put(row!.file_key, 'circular contents', { contentType: 'application/pdf' });
  return documentId;
}

describe('STR-133 T-C1 — the mobile bulletin surface conforms to the Mobile OpenAPI (covers TC-COM-002)', () => {
  it('GET /v1/me/bulletin conforms', async () => {
    const ecId = await ecMember('Contract EC');
    const memberId = await activeMember('Contract Feed Reader');
    await createBulletinPost(db, ecId, { scope: 'society', title: 'Contract notice', body: 'Body.' });

    const response = await dispatchRequest('GET', '/v1/me/bulletin?scope=all', {}, await asMember(db, memberId));
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/me/bulletin', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
    expect((response.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('GET /v1/me/bulletin returns 401 without a caller identity', async () => {
    const response = await dispatchRequest('GET', '/v1/me/bulletin');
    expect(response.status).toBe(401);
    const op = await contractTest('mobile', '/me/bulletin', 'get');
    expect(() => op.expectValidResponse(401, response.body)).not.toThrow();
  });

  it('GET /v1/me/bulletin/{postId} conforms, and 404s a post outside the caller\'s boards', async () => {
    const memberId = await activeMember('Contract Post Reader');
    const pcId = await activeMember('Contract PC');
    const projectId = await projectWithOwner(memberId);
    await setProjectCommittee(
      db,
      projectId,
      { chair_member_id: pcId, member_ids: [pcId] },
      { ownershipLookup: async () => true },
    );
    const documentId = await attachableDocument(projectId);
    const post = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: projectId,
      title: 'Lift servicing',
      body: 'Lift down on Monday.',
      attachments: [documentId],
    });

    const response = await dispatchRequest('GET', `/v1/me/bulletin/${post.postId}`, {}, await asMember(db, memberId));
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/me/bulletin/{postId}', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();

    const outsiderId = await activeMember('Contract Outsider');
    const refused = await dispatchRequest(
      'GET',
      `/v1/me/bulletin/${post.postId}`,
      {},
      await asMember(db, outsiderId),
    );
    expect(refused.status).toBe(404);
    expect(() => op.expectValidResponse(404, refused.body)).not.toThrow();
  });

  it('GET /v1/me/bulletin/{postId}/attachments/{documentId} conforms, and 404s for a member outside the board', async () => {
    const memberId = await activeMember('Contract Attachment Reader');
    const pcId = await activeMember('Contract Attachment PC');
    const projectId = await projectWithOwner(memberId);
    await setProjectCommittee(
      db,
      projectId,
      { chair_member_id: pcId, member_ids: [pcId] },
      { ownershipLookup: async () => true },
    );
    const documentId = await attachableDocument(projectId);
    const post = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: projectId,
      title: 'Circular',
      body: 'See attached.',
      attachments: [documentId],
    });

    const path = `/v1/me/bulletin/${post.postId}/attachments/${documentId}`;
    const op = await contractTest('mobile', '/me/bulletin/{postId}/attachments/{documentId}', 'get');

    const response = await dispatchRequest('GET', path, {}, await asMember(db, memberId));
    expect(response.status).toBe(200);
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();

    const outsiderId = await activeMember('Contract Attachment Outsider');
    const refused = await dispatchRequest('GET', path, {}, await asMember(db, outsiderId));
    expect(refused.status).toBe(404);
    expect(() => op.expectValidResponse(404, refused.body)).not.toThrow();

    // A document that exists but is not attached to this post is not
    // reachable through the post's attachment route either.
    const unattached = await attachableDocument(projectId);
    const wrongDoc = await dispatchRequest(
      'GET',
      `/v1/me/bulletin/${post.postId}/attachments/${unattached}`,
      {},
      await asMember(db, memberId),
    );
    expect(wrongDoc.status).toBe(404);
    expect(() => op.expectValidResponse(404, wrongDoc.body)).not.toThrow();
  });
});
