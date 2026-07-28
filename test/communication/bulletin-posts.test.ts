import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole, vacateRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import {
  createBulletinPost,
  archiveBulletinPost,
  editBulletinPost,
  setBulletinPostPinned,
  listBulletinPosts,
  bulletinPostPublishedListeners,
  BulletinPostAuthorityError,
  BulletinPostValidationError,
  BulletinPostConflictError,
  type BulletinPostPublishedEvent,
  type DocumentLookupPort,
} from '../../aws-blocks/communication/bulletin-posts';

// STR-131 — BulletinPost entity, posting authority and the
// archive-never-delete invariant, unit cases. Follows the STR-043/STR-121
// test pattern: fresh Database + Scope per test, all migrations applied via
// MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-131-bulletin-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  // The listener array is module-global (the STR-032 event-seam shape), so a
  // test that registers one must leave it empty for the next.
  bulletinPostPublishedListeners.length = 0;
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

/** Creates a member and admits them, landing at `active`. */
async function activeMember(db: Database, name: string) {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  return member;
}

/** An active member holding an open EC office (management -> executive_member,
 * the STR-041 subset chain). */
async function ecMember(db: Database, name: string) {
  const member = await activeMember(db, name);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'admin-1');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'admin-1');
  return member;
}

/** An ownership lookup that answers `true` for exactly the given (member, project) pairs. */
function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

/** Seats `memberIds` on `projectId`'s PC (chair is the first id). */
async function seatOnPc(db: Database, projectId: string, memberIds: string[]) {
  await setProjectCommittee(
    db,
    projectId,
    { chair_member_id: memberIds[0], member_ids: memberIds },
    { ownershipLookup: ownershipAmong(memberIds.map(id => [id, projectId] as [string, string])) },
  );
}

/** The story's `FakeDocumentLookup`: exactly the listed document ids exist. */
function documentsNamed(ids: readonly string[]): DocumentLookupPort {
  return async (_db, documentId) => ids.includes(documentId);
}

// T-U1 (covers TC-COM-005): posting authority follows the committee seat --
// a member at large is refused on every board; an EC office holder posts to
// the society board; a PC seat holder posts only to their own project board.
describe('STR-131 T-U1 — posting authority follows committee membership (covers TC-COM-005)', () => {
  it('refuses a member at large on the society board and on any project board', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const atLarge = await activeMember(db, 'Member At Large');

    await expect(
      createBulletinPost(db, atLarge.member_id, { scope: 'society', title: 'Notice', body: 'Body' }),
    ).rejects.toThrow(BulletinPostAuthorityError);

    await expect(
      createBulletinPost(db, atLarge.member_id, {
        scope: 'project',
        project_id: project.project_id,
        title: 'Notice',
        body: 'Body',
      }),
    ).rejects.toThrow(BulletinPostAuthorityError);

    const rows = await db.query(sql`SELECT * FROM bulletin_posts`);
    expect(rows).toHaveLength(0);
  });

  it('lets a current EC office holder post to the society board', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');

    const post = await createBulletinPost(db, ec.member_id, {
      scope: 'society',
      title: 'AGM on 12 August',
      body: 'The AGM will be held in the community hall.',
    });

    expect(post.scope).toBe('society');
    expect(post.projectId).toBeNull();
    expect(post.authorMemberId).toBe(ec.member_id);
    expect(post.pinned).toBe(false);
    expect(post.archived).toBe(false);
    expect(post.editedAt).toBeNull();
  });

  it('lets a PC seat holder post to their own project board but not to another project board', async () => {
    const db = await freshMigratedDb();
    const own = await createProject(db, { name: 'Tower A Repainting' });
    const other = await createProject(db, { name: 'Tower B Lift' });
    const pc = await activeMember(db, 'PC Member');
    await seatOnPc(db, own.project_id, [pc.member_id]);

    const post = await createBulletinPost(db, pc.member_id, {
      scope: 'project',
      project_id: own.project_id,
      title: 'Scaffolding up on Monday',
      body: 'Please keep balconies clear.',
    });
    expect(post.projectId).toBe(own.project_id);

    await expect(
      createBulletinPost(db, pc.member_id, {
        scope: 'project',
        project_id: other.project_id,
        title: 'Lift shutdown',
        body: 'Not my board.',
      }),
    ).rejects.toThrow(BulletinPostAuthorityError);

    // A PC seat is not society-board authority either.
    await expect(
      createBulletinPost(db, pc.member_id, { scope: 'society', title: 'Society-wide', body: 'Not my board.' }),
    ).rejects.toThrow(BulletinPostAuthorityError);
  });
});

// T-U2 (covers TC-COM-004): archiving is a state, not a delete; `pinned` is
// an independent flag either way.
describe('STR-131 T-U2 — archive hides but never deletes; pinned is independent (covers TC-COM-004)', () => {
  it('drops an archived post from the active board read while keeping the row', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    const kept = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Kept', body: 'Still up.' });
    const removed = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Removed', body: 'Taken down.' });

    const archived = await archiveBulletinPost(db, removed.postId);
    expect(archived!.archived).toBe(true);
    expect(archived!.archivedAt).not.toBeNull();

    const active = await listBulletinPosts(db, { scope: 'society' });
    expect(active.map(p => p.postId)).toEqual([kept.postId]);

    const all = await listBulletinPosts(db, { scope: 'society', includeArchived: true });
    expect(all.map(p => p.postId).sort()).toEqual([kept.postId, removed.postId].sort());

    // The row itself is untouched by the read filter -- never deleted.
    const rows = await db.query<{ id: string }>(sql`SELECT id FROM bulletin_posts WHERE id = ${removed.postId}`);
    expect(rows).toHaveLength(1);
  });

  it('toggles pinned in both directions independently of archived', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    const post = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Notice', body: 'Body' });

    expect((await setBulletinPostPinned(db, post.postId, true))!.pinned).toBe(true);

    // Archiving leaves the pin flag exactly as it was.
    const archived = await archiveBulletinPost(db, post.postId);
    expect(archived!.archived).toBe(true);
    expect(archived!.pinned).toBe(true);

    // And an archived post can still be unpinned and re-pinned -- the two are
    // orthogonal, not a single lifecycle.
    expect((await setBulletinPostPinned(db, post.postId, false))!.pinned).toBe(false);
    const repinned = await setBulletinPostPinned(db, post.postId, true);
    expect(repinned!.pinned).toBe(true);
    expect(repinned!.archived).toBe(true);
  });
});

// T-U3: attribution is recorded at post time, authority is checked at post
// time -- vacating the seat afterwards changes only the latter.
describe('STR-131 T-U3 — losing the seat stops new posts but never rewrites past attribution', () => {
  it('keeps the author on an existing post and refuses that member a new one', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'Outgoing EC Member');
    const post = await createBulletinPost(db, ec.member_id, {
      scope: 'society',
      title: 'Water tank cleaning',
      body: 'Scheduled for Saturday.',
    });

    await vacateRole(db, ec.member_id, 'executive_member', '2026-06-30', 'admin-1');

    const [existing] = await listBulletinPosts(db, { scope: 'society' });
    expect(existing.postId).toBe(post.postId);
    expect(existing.authorMemberId).toBe(ec.member_id);

    await expect(
      createBulletinPost(db, ec.member_id, { scope: 'society', title: 'One more', body: 'No longer allowed.' }),
    ).rejects.toThrow(BulletinPostAuthorityError);
  });
});

// T-U4: the scope/project_id pairing is an invariant of the entity, and the
// project-board check is its own gate -- an EC office does not carry it.
describe('STR-131 T-U4 — scope and project_id pair up; the project-board check stands alone', () => {
  it('records a society post with no project_id and a project post with one', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Tower A Repainting' });
    const ec = await ecMember(db, 'EC Member');
    const pc = await activeMember(db, 'PC Member');
    await seatOnPc(db, project.project_id, [pc.member_id]);

    const societyPost = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'S', body: 'B' });
    expect(societyPost.projectId).toBeNull();

    const projectPost = await createBulletinPost(db, pc.member_id, {
      scope: 'project',
      project_id: project.project_id,
      title: 'P',
      body: 'B',
    });
    expect(projectPost.projectId).toBe(project.project_id);
  });

  it('rejects a society post carrying a project_id and a project post missing one', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Tower A Repainting' });
    const ec = await ecMember(db, 'EC Member');

    await expect(
      createBulletinPost(db, ec.member_id, {
        scope: 'society',
        project_id: project.project_id,
        title: 'S',
        body: 'B',
      }),
    ).rejects.toThrow(BulletinPostValidationError);

    await expect(
      createBulletinPost(db, ec.member_id, { scope: 'project', title: 'P', body: 'B' }),
    ).rejects.toThrow(BulletinPostValidationError);
  });

  it('refuses an EC office holder on a project board they hold no PC seat on', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Tower A Repainting' });
    const ec = await ecMember(db, 'EC Member');

    await expect(
      createBulletinPost(db, ec.member_id, {
        scope: 'project',
        project_id: project.project_id,
        title: 'P',
        body: 'B',
      }),
    ).rejects.toThrow(BulletinPostAuthorityError);
  });
});

// T-U5: publishing always emits, and emitting is not a dependency.
describe('STR-131 T-U5 — publishing appends exactly one bulletinPostPublished event', () => {
  it('delivers one event carrying the post, scope, project and author', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Tower A Repainting' });
    const pc = await activeMember(db, 'PC Member');
    await seatOnPc(db, project.project_id, [pc.member_id]);

    const seen: BulletinPostPublishedEvent[] = [];
    bulletinPostPublishedListeners.push(async event => {
      seen.push(event);
    });

    const post = await createBulletinPost(db, pc.member_id, {
      scope: 'project',
      project_id: project.project_id,
      title: 'P',
      body: 'B',
    });

    expect(seen).toEqual([
      { postId: post.postId, scope: 'project', projectId: project.project_id, authorMemberId: pc.member_id },
    ]);
  });

  it('publishes successfully with zero listeners registered', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    expect(bulletinPostPublishedListeners).toHaveLength(0);

    const post = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'S', body: 'B' });
    expect(post.postId).toBeTruthy();
  });

  it('emits nothing when the create is refused', async () => {
    const db = await freshMigratedDb();
    const atLarge = await activeMember(db, 'Member At Large');
    const seen: BulletinPostPublishedEvent[] = [];
    bulletinPostPublishedListeners.push(async event => {
      seen.push(event);
    });

    await expect(
      createBulletinPost(db, atLarge.member_id, { scope: 'society', title: 'S', body: 'B' }),
    ).rejects.toThrow(BulletinPostAuthorityError);
    expect(seen).toEqual([]);
  });
});

// The Green section's attachment rule and the shared edit guard STR-132 and
// STR-134 both call through.
describe('STR-131 — attachments validate through the document-lookup port', () => {
  it('records known document ids and rejects an unknown one, writing nothing', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    const documentLookup = documentsNamed(['doc-1', 'doc-2']);

    const post = await createBulletinPost(
      db,
      ec.member_id,
      { scope: 'society', title: 'Circular', body: 'See attached.', attachments: ['doc-1', 'doc-2'] },
      { documentLookup },
    );
    expect(post.attachments.sort()).toEqual(['doc-1', 'doc-2']);

    await expect(
      createBulletinPost(
        db,
        ec.member_id,
        { scope: 'society', title: 'Circular', body: 'See attached.', attachments: ['doc-1', 'doc-missing'] },
        { documentLookup },
      ),
    ).rejects.toThrow(BulletinPostValidationError);

    const rows = await db.query(sql`SELECT id FROM bulletin_posts`);
    expect(rows).toHaveLength(1);
  });
});

describe('STR-131 — editing audits the editor and refuses an archived post', () => {
  it('stamps editor_member_id/edited_at on an active post', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    const editor = await ecMember(db, 'Second EC Member');
    const post = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Old', body: 'Old body' });

    const edited = await editBulletinPost(db, post.postId, editor.member_id, { title: 'New', body: 'New body' });
    expect(edited!.title).toBe('New');
    expect(edited!.body).toBe('New body');
    expect(edited!.editorMemberId).toBe(editor.member_id);
    expect(edited!.editedAt).not.toBeNull();
    // Attribution is the author's, not the editor's.
    expect(edited!.authorMemberId).toBe(ec.member_id);
  });

  it('rejects an edit to an already-archived post', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'EC Member');
    const post = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Old', body: 'Old body' });
    await archiveBulletinPost(db, post.postId);

    await expect(
      editBulletinPost(db, post.postId, ec.member_id, { title: 'New' }),
    ).rejects.toThrow(BulletinPostConflictError);
  });
});
