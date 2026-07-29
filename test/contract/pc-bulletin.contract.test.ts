import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import { registerDocument } from '../../aws-blocks/documents/documents-api';
import { createBulletinPost, archiveBulletinPost } from '../../aws-blocks/communication/bulletin-posts';

// STR-134 T-C1 (BE-C, covers TC-COM-006/007/008) -- the two `/pc` bulletin
// write operations against the Mobile OpenAPI document, dispatched through
// the real handlers (the me-bulletin.contract.test.ts pattern).

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function activeMember(name: string): Promise<string> {
  const member = await createMember(db, { name: `${name} ${randomUUID()}` });
  await admitMember(db, member.member_id);
  return member.member_id;
}

async function projectWithPc(memberId: string): Promise<string> {
  const project = await createProject(db, { name: `Contract Project ${randomUUID()}` });
  await setProjectCommittee(
    db,
    project.project_id,
    { chair_member_id: memberId, member_ids: [memberId] },
    { ownershipLookup: async () => true },
  );
  return project.project_id;
}

describe('STR-134 T-C1 -- the /pc bulletin write conforms to the Mobile OpenAPI', () => {
  it('POST /v1/pc/projects/{projectId}/posts conforms on 201', async () => {
    const pcId = await activeMember('Contract PC Author');
    const projectId = await projectWithPc(pcId);
    const { documentId } = await registerDocument(db, documents, {
      level: 'project',
      projectId,
      title: 'Lift AMC circular',
      category: 'Correspondence',
      filename: 'circular.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'emp-1',
    });

    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { title: 'Lift servicing', body: 'Lift down on Monday.', attachment_document_ids: [documentId] },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(201);
    const op = await contractTest('mobile', '/pc/projects/{projectId}/posts', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('POST /v1/pc/projects/{projectId}/posts conforms on 401, 403 and 422', async () => {
    const pcId = await activeMember('Contract PC Refused');
    const projectId = await projectWithPc(pcId);
    const otherProjectId = await projectWithPc(await activeMember('Contract Other PC'));
    const op = await contractTest('mobile', '/pc/projects/{projectId}/posts', 'post');

    const anonymous = await dispatchRequest('POST', `/v1/pc/projects/${projectId}/posts`, {
      title: 'No caller',
      body: 'Body.',
    });
    expect(anonymous.status).toBe(401);
    expect(() => op.expectValidResponse(401, anonymous.body)).not.toThrow();

    const wrongProject = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${otherProjectId}/posts`,
      { title: 'Not my board', body: 'Body.' },
      { 'X-Actor-Member-Id': pcId },
    );
    expect(wrongProject.status).toBe(403);
    expect((wrongProject.body as { error: { code: string } }).error.code).toBe('capability_required');
    expect(() => op.expectValidResponse(403, wrongProject.body)).not.toThrow();

    const blank = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { body: 'No title.' },
      { 'X-Actor-Member-Id': pcId },
    );
    expect(blank.status).toBe(422);
    expect(() => op.expectValidResponse(422, blank.body)).not.toThrow();
  });

  it('POST /v1/pc/projects/{projectId}/posts conforms on 404 for an unknown project', async () => {
    const pcId = await activeMember('Contract PC Ghost Project');
    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${randomUUID()}/posts`,
      { title: 'Nowhere', body: 'Body.' },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(404);
    const op = await contractTest('mobile', '/pc/projects/{projectId}/posts', 'post');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });

  it('PATCH /v1/pc/posts/{postId} conforms on 200', async () => {
    const pcId = await activeMember('Contract PC Editor');
    const projectId = await projectWithPc(pcId);
    const post = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: projectId,
      title: 'Lift servicing',
      body: 'Lift down on Monday.',
    });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Lift down on Monday and Tuesday.' },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/pc/posts/{postId}', 'patch');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('PATCH /v1/pc/posts/{postId} conforms on 403, 404 and 409', async () => {
    const pcId = await activeMember('Contract PC Guarded');
    const outsiderId = await activeMember('Contract Outsider');
    const projectId = await projectWithPc(pcId);
    const post = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: projectId,
      title: 'Board notice',
      body: 'Original body.',
    });
    const op = await contractTest('mobile', '/pc/posts/{postId}', 'patch');

    const forbidden = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Tampered.' },
      { 'X-Actor-Member-Id': outsiderId },
    );
    expect(forbidden.status).toBe(403);
    expect(() => op.expectValidResponse(403, forbidden.body)).not.toThrow();

    const missing = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${randomUUID()}`,
      { body: 'Nowhere.' },
      { 'X-Actor-Member-Id': pcId },
    );
    expect(missing.status).toBe(404);
    expect(() => op.expectValidResponse(404, missing.body)).not.toThrow();

    await archiveBulletinPost(db, post.postId);
    const archived = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Reinstated.' },
      { 'X-Actor-Member-Id': pcId },
    );
    expect(archived.status).toBe(409);
    expect(() => op.expectValidResponse(409, archived.body)).not.toThrow();
  });
});
