import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { dispatchRequest } from '../support/dispatch';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import { registerDocument } from '../../aws-blocks/documents/documents-api';
import {
  createBulletinPost,
  getBulletinPost,
  archiveBulletinPost,
} from '../../aws-blocks/communication/bulletin-posts';

// STR-134 -- the mobile `/pc` bulletin write, dispatched against the real
// routes over the singleton `db` (the STR-132 bulletin-posts-admin.test.ts
// pattern; the handlers close over that instance). This surface is gated on
// a current PC seat directly, never on a capability: Governance & Roles is
// explicit that PC seats confer no admin-panel capability (AC4).

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function activeMember(name: string): Promise<string> {
  const member = await createMember(db, { name: `${name} ${randomUUID()}` });
  await admitMember(db, member.member_id);
  return member.member_id;
}

function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

/** Seats `memberIds` on `projectId`'s PC (chair is the first id). */
async function seatOnPc(projectId: string, memberIds: string[]): Promise<void> {
  await setProjectCommittee(
    db,
    projectId,
    { chair_member_id: memberIds[0], member_ids: memberIds },
    { ownershipLookup: ownershipAmong(memberIds.map(id => [id, projectId] as [string, string])) },
  );
}

/** A project whose PC seats `memberIds`. */
async function projectWithPc(memberIds: string[]): Promise<string> {
  const project = await createProject(db, { name: `Tower Repainting ${randomUUID()}` });
  await seatOnPc(project.project_id, memberIds);
  return project.project_id;
}

async function projectDocument(projectId: string): Promise<string> {
  const { documentId } = await registerDocument(db, documents, {
    level: 'project',
    projectId,
    title: 'Repainting quote',
    category: 'Correspondence',
    filename: 'quote.pdf',
    contentType: 'application/pdf',
    uploadedBy: 'emp-1',
  });
  return documentId;
}

describe('STR-134 T-U1 -- a current PC seat holder posts to their own project board (covers TC-COM-006)', () => {
  it('publishes a project post on the board the caller sits on', async () => {
    const pcId = await activeMember('PC Author');
    const projectId = await projectWithPc([pcId]);

    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { title: 'Scaffolding up on Monday', body: 'Please keep balconies clear.' },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(201);
    const body = response.body as { post_id: string; scope: string; project_id: string; author: { member_id: string } };
    expect(body.scope).toBe('project');
    expect(body.project_id).toBe(projectId);
    expect(body.author.member_id).toBe(pcId);

    // Delegated straight to STR-131's createBulletinPost -- the row it wrote
    // is the one the response describes.
    const stored = await getBulletinPost(db, body.post_id);
    expect(stored!.scope).toBe('project');
    expect(stored!.projectId).toBe(projectId);
    expect(stored!.authorMemberId).toBe(pcId);
  });

  it('refuses a project the caller does not sit on with 403 capability_required', async () => {
    const pcId = await activeMember('PC Elsewhere');
    await projectWithPc([pcId]);
    const otherProjectId = await projectWithPc([await activeMember('Other PC')]);

    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${otherProjectId}/posts`,
      { title: 'Not my board', body: 'Should never land.' },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('capability_required');
  });
});

describe('STR-134 T-U2 -- attachments must be project-level registry documents of this project (covers TC-COM-007)', () => {
  it('accepts an attachment registered as a project-level document of the board`s project', async () => {
    const pcId = await activeMember('PC Attacher');
    const projectId = await projectWithPc([pcId]);
    const documentId = await projectDocument(projectId);

    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { title: 'Quote circulated', body: 'See attached.', attachment_document_ids: [documentId] },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(201);
    const stored = await getBulletinPost(db, (response.body as { post_id: string }).post_id);
    expect(stored!.attachments).toEqual([documentId]);
  });

  it('rejects an attachment id the registry does not know', async () => {
    const pcId = await activeMember('PC Bad Attacher');
    const projectId = await projectWithPc([pcId]);

    const response = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { title: 'Bogus', body: 'See attached.', attachment_document_ids: [randomUUID()] },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(422);
  });

  it('rejects a society-level document, and a project document belonging to another project', async () => {
    const pcId = await activeMember('PC Cross Attacher');
    const projectId = await projectWithPc([pcId]);
    const otherProjectId = await projectWithPc([await activeMember('Other Board PC')]);
    const { documentId: societyDocumentId } = await registerDocument(db, documents, {
      level: 'society',
      title: 'Society bye-laws',
      category: 'Correspondence',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'emp-1',
    });
    const otherProjectDocumentId = await projectDocument(otherProjectId);

    for (const documentId of [societyDocumentId, otherProjectDocumentId]) {
      const response = await dispatchRequest(
        'POST',
        `/v1/pc/projects/${projectId}/posts`,
        { title: 'Wrong document', body: 'See attached.', attachment_document_ids: [documentId] },
        { 'X-Actor-Member-Id': pcId },
      );
      expect(response.status).toBe(422);
    }
  });
});

describe('STR-134 T-U3 -- any current PC member edits the board`s post, audited; archived is 409 (covers TC-COM-008)', () => {
  it('lets a PC member who is not the author edit, and audits editor and edited_at', async () => {
    const authorId = await activeMember('PC Original Author');
    const colleagueId = await activeMember('PC Colleague');
    const projectId = await projectWithPc([authorId, colleagueId]);
    const post = await createBulletinPost(db, authorId, {
      scope: 'project',
      project_id: projectId,
      title: 'Scaffolding up on Monday',
      body: 'Please keep balconies clear.',
    });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Please keep balconies clear until Friday.' },
      { 'X-Actor-Member-Id': colleagueId },
    );

    expect(response.status).toBe(200);
    const stored = await getBulletinPost(db, post.postId);
    expect(stored!.body).toBe('Please keep balconies clear until Friday.');
    // Attribution is never rewritten -- only the edit audit moves.
    expect(stored!.authorMemberId).toBe(authorId);
    expect(stored!.editorMemberId).toBe(colleagueId);
    expect(stored!.editedAt).not.toBeNull();
  });

  it('refuses an editor who sits on no PC seat of that project with 403 capability_required', async () => {
    const authorId = await activeMember('PC Guarded Author');
    const outsiderId = await activeMember('Plain Member');
    const projectId = await projectWithPc([authorId]);
    const post = await createBulletinPost(db, authorId, {
      scope: 'project',
      project_id: projectId,
      title: 'Board notice',
      body: 'Original body.',
    });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Tampered.' },
      { 'X-Actor-Member-Id': outsiderId },
    );

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('capability_required');
    expect((await getBulletinPost(db, post.postId))!.body).toBe('Original body.');
  });

  it('409s an edit of an archived post', async () => {
    const pcId = await activeMember('PC Archived Editor');
    const projectId = await projectWithPc([pcId]);
    const post = await createBulletinPost(db, pcId, {
      scope: 'project',
      project_id: projectId,
      title: 'Withdrawn notice',
      body: 'Original body.',
    });
    await archiveBulletinPost(db, post.postId);

    const response = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Reinstated.' },
      { 'X-Actor-Member-Id': pcId },
    );

    expect(response.status).toBe(409);
    expect((await getBulletinPost(db, post.postId))!.body).toBe('Original body.');
  });
});

// A genuine gap in the story's Red list, declared by the contract ("404 for
// society posts (not governed here)") and reachable by a real caller: a PC
// member naming a society post on their own surface. Without it the seat
// lookup would be asked about a null project.
describe('STR-134 T-U5 -- the /pc edit does not reach the society board', () => {
  it('404s a society post named on the /pc surface, even for a seated PC member', async () => {
    const pcId = await activeMember('PC Society Reacher');
    await projectWithPc([pcId]);
    const ecId = await activeMember('EC Society Author');
    await assignRole(db, ecId, 'management', '2026-01-01', 'admin-1');
    await assignRole(db, ecId, 'executive_member', '2026-01-01', 'admin-1');
    const post = await createBulletinPost(db, ecId, {
      scope: 'society',
      title: 'AGM on 12 August',
      body: 'Original body.',
    });

    const response = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Tampered.' },
      { 'X-Actor-Member-Id': pcId },
    );

    // The problem body, not just the status: an unmatched route 404s too, so
    // asserting the status alone would pass before the route exists.
    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('not_found');
    expect((await getBulletinPost(db, post.postId))!.body).toBe('Original body.');
  });
});

describe('STR-134 T-U4 -- a vacated seat ends the write, but never rewrites past attribution', () => {
  it('refuses create and edit once the seat is vacated, while the old post keeps its author', async () => {
    const formerId = await activeMember('PC Former Seat');
    const successorId = await activeMember('PC Successor');
    const projectId = await projectWithPc([formerId]);
    const post = await createBulletinPost(db, formerId, {
      scope: 'project',
      project_id: projectId,
      title: 'Posted while seated',
      body: 'Original body.',
    });

    await seatOnPc(projectId, [successorId]);

    const created = await dispatchRequest(
      'POST',
      `/v1/pc/projects/${projectId}/posts`,
      { title: 'After the seat went', body: 'Should never land.' },
      { 'X-Actor-Member-Id': formerId },
    );
    expect(created.status).toBe(403);

    const edited = await dispatchRequest(
      'PATCH',
      `/v1/pc/posts/${post.postId}`,
      { body: 'Tampered.' },
      { 'X-Actor-Member-Id': formerId },
    );
    expect(edited.status).toBe(403);

    // STR-131's invariant, not reimplemented here: authorship stands.
    const stored = await getBulletinPost(db, post.postId);
    expect(stored!.authorMemberId).toBe(formerId);
    expect(stored!.body).toBe('Original body.');
  });
});
