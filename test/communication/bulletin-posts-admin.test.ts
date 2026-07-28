import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { dispatchRequest } from '../support/dispatch';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import { createBulletinPost, getBulletinPost, listBulletinPosts } from '../../aws-blocks/communication/bulletin-posts';

// STR-132 -- the Admin API bulletin-posts surface, dispatched against the
// real routes over the singleton `db` (the ec-invoices.contract.test.ts
// pattern; the handlers close over that instance, so a fresh Database of
// this file's own would never be the one they read).

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function activeMember(name: string): Promise<string> {
  const member = await createMember(db, { name: `${name} ${randomUUID()}` });
  await admitMember(db, member.member_id);
  return member.member_id;
}

/** An active member holding an open EC office (the STR-041 subset chain). */
async function ecMember(name: string): Promise<string> {
  const memberId = await activeMember(name);
  await assignRole(db, memberId, 'management', '2026-01-01', 'admin-1');
  await assignRole(db, memberId, 'executive_member', '2026-01-01', 'admin-1');
  return memberId;
}

/** An active member holding Management but no EC office -- moderation
 * authority without composing authority. */
async function managementMember(name: string): Promise<string> {
  const memberId = await activeMember(name);
  await assignRole(db, memberId, 'management', '2026-01-01', 'admin-1');
  return memberId;
}

function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

/** A project whose PC seats `memberId`, plus one post already on its board. */
async function projectPost(memberId: string): Promise<{ projectId: string; postId: string }> {
  const project = await createProject(db, { name: `Tower Repainting ${randomUUID()}` });
  await setProjectCommittee(
    db,
    project.project_id,
    { chair_member_id: memberId, member_ids: [memberId] },
    { ownershipLookup: ownershipAmong([[memberId, project.project_id]]) },
  );
  const post = await createBulletinPost(db, memberId, {
    scope: 'project',
    project_id: project.project_id,
    title: 'Scaffolding up on Monday',
    body: 'Please keep balconies clear.',
  });
  return { projectId: project.project_id, postId: post.postId };
}

describe('STR-132 T-U1 -- EC compose on the society board, capability-gated', () => {
  it('lets a current EC office holder publish a society post', async () => {
    const ecId = await ecMember('EC Composer');

    const response = await dispatchRequest(
      'POST',
      '/v1/bulletin-posts',
      { title: 'AGM on 12 August', body: 'The AGM will be held in the community hall.' },
      { 'X-Actor-Member-Id': ecId },
    );

    expect(response.status).toBe(201);
    const body = response.body as { post_id: string; scope: string; status: string; author: { member_id: string } };
    expect(body.scope).toBe('society');
    expect(body.status).toBe('active');
    expect(body.author.member_id).toBe(ecId);

    // Delegated straight to STR-131's createBulletinPost -- the row it wrote
    // is the one the response describes.
    const stored = await getBulletinPost(db, body.post_id);
    expect(stored!.scope).toBe('society');
    expect(stored!.projectId).toBeNull();
    expect(stored!.authorMemberId).toBe(ecId);
  });

  it('refuses a caller without the bulletin_compose capability with 403 capability_required', async () => {
    const atLargeId = await activeMember('Member At Large');

    const response = await dispatchRequest(
      'POST',
      '/v1/bulletin-posts',
      { title: 'Unauthorised notice', body: 'Should never be posted.' },
      { 'X-Actor-Member-Id': atLargeId },
    );

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('capability_required');

    const rows = await db.query(sql`SELECT id FROM bulletin_posts WHERE title = 'Unauthorised notice'`);
    expect(rows).toHaveLength(0);
  });
});

describe('STR-132 T-U2 -- admin edits reach society posts only (covers TC-COM-009)', () => {
  it('edits a society post and audits the editor', async () => {
    const authorId = await ecMember('EC Author');
    const editorId = await ecMember('EC Editor');
    const created = await createBulletinPost(db, authorId, {
      scope: 'society',
      title: 'Water tank cleaning',
      body: 'Scheduled for Saturday.',
    });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/bulletin-posts/${created.postId}`,
      { title: 'Water tank cleaning postponed', body: 'Now scheduled for Sunday.' },
      { 'X-Actor-Member-Id': editorId },
    );

    expect(response.status).toBe(200);
    const body = response.body as { title: string; edited_at: string | null };
    expect(body.title).toBe('Water tank cleaning postponed');
    expect(body.edited_at).not.toBeNull();

    const stored = await getBulletinPost(db, created.postId);
    expect(stored!.editorMemberId).toBe(editorId);
    expect(stored!.authorMemberId).toBe(authorId);
  });

  it('refuses an edit to a project post with 409 -- a PC post is never clobbered from the admin panel', async () => {
    const pcId = await activeMember('PC Member');
    const { postId } = await projectPost(pcId);
    const ecId = await ecMember('EC Would-Be Editor');

    const response = await dispatchRequest(
      'PATCH',
      `/v1/bulletin-posts/${postId}`,
      { title: 'Admin rewrite', body: 'Not the admin panel to make.' },
      { 'X-Actor-Member-Id': ecId },
    );

    expect(response.status).toBe(409);
    const stored = await getBulletinPost(db, postId);
    expect(stored!.title).toBe('Scaffolding up on Monday');
    expect(stored!.editorMemberId).toBeNull();
  });

  it('refuses an edit to an archived society post with 409', async () => {
    const ecId = await ecMember('EC Archived-Post Editor');
    const created = await createBulletinPost(db, ecId, { scope: 'society', title: 'Old notice', body: 'Body' });
    const moderatorId = await managementMember('Management Moderator For Edit');
    await dispatchRequest('POST', `/v1/bulletin-posts/${created.postId}/archive`, {}, { 'X-Actor-Member-Id': moderatorId });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/bulletin-posts/${created.postId}`,
      { body: 'Trying to edit after take-down.' },
      { 'X-Actor-Member-Id': ecId },
    );

    expect(response.status).toBe(409);
    expect((await getBulletinPost(db, created.postId))!.body).toBe('Body');
  });
});

describe('STR-132 T-U3 -- archive moderation spans both boards and never deletes', () => {
  it('archives a society post: hidden from the active board, row still there', async () => {
    const ecId = await ecMember('EC Author For Archive');
    const created = await createBulletinPost(db, ecId, { scope: 'society', title: 'Taken down', body: 'Body' });
    const moderatorId = await managementMember('Management Moderator');

    const response = await dispatchRequest(
      'POST',
      `/v1/bulletin-posts/${created.postId}/archive`,
      {},
      { 'X-Actor-Member-Id': moderatorId },
    );

    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('archived');

    const active = await listBulletinPosts(db, { scope: 'society' });
    expect(active.map(p => p.postId)).not.toContain(created.postId);

    const rows = await db.query<{ id: string }>(sql`SELECT id FROM bulletin_posts WHERE id = ${created.postId}`);
    expect(rows).toHaveLength(1);
  });

  it('archives a project post too -- moderation is not authorship', async () => {
    const pcId = await activeMember('PC Member For Archive');
    const { projectId, postId } = await projectPost(pcId);
    const moderatorId = await ecMember('EC Moderator');

    const response = await dispatchRequest(
      'POST',
      `/v1/bulletin-posts/${postId}/archive`,
      {},
      { 'X-Actor-Member-Id': moderatorId },
    );

    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('archived');

    const active = await listBulletinPosts(db, { scope: 'project', projectId });
    expect(active.map(p => p.postId)).not.toContain(postId);
    expect((await getBulletinPost(db, postId))!.archived).toBe(true);
  });

  it('refuses a caller without the bulletin_moderate capability with 403 capability_required', async () => {
    const ecId = await ecMember('EC Author For Denied Archive');
    const created = await createBulletinPost(db, ecId, { scope: 'society', title: 'Stays up', body: 'Body' });
    const atLargeId = await activeMember('Member At Large Moderator');

    const response = await dispatchRequest(
      'POST',
      `/v1/bulletin-posts/${created.postId}/archive`,
      {},
      { 'X-Actor-Member-Id': atLargeId },
    );

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('capability_required');
    expect((await getBulletinPost(db, created.postId))!.archived).toBe(false);
  });
});
