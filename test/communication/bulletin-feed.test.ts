import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import {
  createBulletinPost,
  archiveBulletinPost,
  setBulletinPostPinned,
} from '../../aws-blocks/communication/bulletin-posts';
import {
  resolveBulletinBoardAudience,
  resolveMemberBulletinBoards,
  listMemberBulletinFeed,
} from '../../aws-blocks/communication/bulletin-audience';

// STR-133 — the mobile bulletin feed. The feed is the *inverse* of the same
// audience computation the new-post push reads (AC3), so these cases and
// test/communication/bulletin-push.test.ts exercise one function from two
// sides. Follows STR-131's test conventions (fresh Database + Scope per
// test, all migrations via MIGRATIONS_DIR).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-133-feed-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

async function activeMember(db: Database, name: string) {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  return member;
}

/** An active member holding an open EC office — the society board's author. */
async function ecMember(db: Database, name: string) {
  const member = await activeMember(db, name);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'admin-1');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'admin-1');
  return member;
}

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

/** Gives `memberId` a current ownership of a fresh asset in `projectId` (E06). */
async function ownInProject(db: Database, projectId: string, memberId: string, label: string) {
  const asset = await createAsset(db, { project_id: projectId, type: 'flat', label });
  return createOwnership(db, memberId, { asset_id: asset.asset_id });
}

/** Pins a post's `posted_at` to an exact instant, so ordering assertions do
 * not depend on how fast consecutive INSERTs run. */
async function postedAt(db: Database, postId: string, iso: string) {
  await db.execute(sql`UPDATE bulletin_posts SET posted_at = ${iso}::timestamptz WHERE id = ${postId}`);
}

describe('STR-133 T-U1 — the feed spans the society board plus the boards the member belongs to (covers TC-COM-001)', () => {
  it("given a member owning in one project only; then a project board they have no ownership in is absent, even while they hold another project's PC seat", async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'Ec Author');
    const member = await activeMember(db, 'Asha Rao');

    const owned = await createProject(db, { name: 'Green Meadows' });
    const seated = await createProject(db, { name: 'Blue Waters' });
    const stranger = await createProject(db, { name: 'Red Hills' });
    await ownInProject(db, owned.project_id, member.member_id, 'A-101');
    // The member's own PC seat is on a *different* project than the one
    // asserted absent below — the story's "some other project's PC seat".
    await seatOnPc(db, seated.project_id, [member.member_id]);

    const ownedPc = await activeMember(db, 'Owned Chair');
    await seatOnPc(db, owned.project_id, [ownedPc.member_id]);
    const strangerPc = await activeMember(db, 'Stranger Chair');
    await seatOnPc(db, stranger.project_id, [strangerPc.member_id]);

    const societyPost = await createBulletinPost(db, ec.member_id, {
      scope: 'society',
      title: 'Society AGM',
      body: 'The AGM is on Saturday.',
    });
    const ownedPost = await createBulletinPost(db, ownedPc.member_id, {
      scope: 'project',
      project_id: owned.project_id,
      title: 'Lift servicing',
      body: 'Lift down on Monday.',
    });
    const strangerPost = await createBulletinPost(db, strangerPc.member_id, {
      scope: 'project',
      project_id: stranger.project_id,
      title: 'Not for Asha',
      body: 'Red Hills only.',
    });

    const ids = (await listMemberBulletinFeed(db, member.member_id, { scope: 'all' })).map(post => post.postId);

    expect(ids).toContain(societyPost.postId);
    expect(ids).toContain(ownedPost.postId);
    expect(ids).not.toContain(strangerPost.postId);
  });

  it("given a member on a project's PC without an ownership there; then that project's board is in their feed (Communication: owners \"plus its PC members\")", async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'Priya Nair');
    const seated = await createProject(db, { name: 'Blue Waters' });
    await seatOnPc(db, seated.project_id, [member.member_id]);

    const seatedPost = await createBulletinPost(db, member.member_id, {
      scope: 'project',
      project_id: seated.project_id,
      title: 'PC notice',
      body: 'Committee update.',
    });

    const feed = await listMemberBulletinFeed(db, member.member_id, { scope: 'all' });
    expect(feed.map(post => post.postId)).toContain(seatedPost.postId);
  });

  it("given a board and a member; then the member is in the board's audience if and only if the board is in their feed's boards — one function, read from both sides (AC3)", async () => {
    const db = await freshMigratedDb();
    const owner = await activeMember(db, 'Owner Om');
    const outsider = await activeMember(db, 'Outsider Ojas');
    const project = await createProject(db, { name: 'Green Meadows' });
    await ownInProject(db, project.project_id, owner.member_id, 'A-101');

    const audience = await resolveBulletinBoardAudience(db, 'project', project.project_id);
    expect(audience).toContain(owner.member_id);
    expect(audience).not.toContain(outsider.member_id);

    const ownerBoards = await resolveMemberBulletinBoards(db, owner.member_id);
    const outsiderBoards = await resolveMemberBulletinBoards(db, outsider.member_id);
    expect(ownerBoards).toContainEqual({ scope: 'project', projectId: project.project_id });
    expect(outsiderBoards).not.toContainEqual({ scope: 'project', projectId: project.project_id });
    // Every member with app access is on the society board, both ways round.
    expect(await resolveBulletinBoardAudience(db, 'society', null)).toContain(outsider.member_id);
    expect(outsiderBoards).toContainEqual({ scope: 'society', projectId: null });
  });
});

describe('STR-133 T-U2 — pinned first, then newest; archived posts never appear (covers TC-COM-002, TC-COM-004)', () => {
  it('given pinned and unpinned posts; then pinned sort first and each group is newest-first', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'Ec Author');
    const member = await activeMember(db, 'Asha Rao');

    const older = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Older', body: 'b' });
    const newer = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Newer', body: 'b' });
    const pinnedOlder = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Pinned older', body: 'b' });
    const pinnedNewer = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Pinned newer', body: 'b' });
    await postedAt(db, older.postId, '2026-07-01T10:00:00Z');
    await postedAt(db, newer.postId, '2026-07-02T10:00:00Z');
    await postedAt(db, pinnedOlder.postId, '2026-06-01T10:00:00Z');
    await postedAt(db, pinnedNewer.postId, '2026-06-02T10:00:00Z');
    await setBulletinPostPinned(db, pinnedOlder.postId, true);
    await setBulletinPostPinned(db, pinnedNewer.postId, true);

    const feed = await listMemberBulletinFeed(db, member.member_id, { scope: 'all' });

    // Both pinned posts precede both unpinned ones even though they are the
    // *older* pair — pinned outranks recency, and recency orders within each
    // group.
    expect(feed.map(post => post.postId)).toEqual([pinnedNewer.postId, pinnedOlder.postId, newer.postId, older.postId]);
  });

  it('given an archived post; then it never appears in the feed, pinned or not', async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'Ec Author');
    const member = await activeMember(db, 'Asha Rao');

    const kept = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Kept', body: 'b' });
    const takenDown = await createBulletinPost(db, ec.member_id, {
      scope: 'society',
      title: 'Taken down',
      body: 'b',
      pinned: true,
    });
    await archiveBulletinPost(db, takenDown.postId);

    const feed = await listMemberBulletinFeed(db, member.member_id, { scope: 'all' });
    expect(feed.map(post => post.postId)).toEqual([kept.postId]);
  });

  it("given the scope and project_id filters; then the feed narrows within the member's own boards, never beyond them", async () => {
    const db = await freshMigratedDb();
    const ec = await ecMember(db, 'Ec Author');
    const member = await activeMember(db, 'Asha Rao');
    const project = await createProject(db, { name: 'Green Meadows' });
    await ownInProject(db, project.project_id, member.member_id, 'A-101');
    await seatOnPc(db, project.project_id, [member.member_id]);

    const societyPost = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'Society', body: 'b' });
    const projectPost = await createBulletinPost(db, member.member_id, {
      scope: 'project',
      project_id: project.project_id,
      title: 'Project',
      body: 'b',
    });

    expect((await listMemberBulletinFeed(db, member.member_id, { scope: 'society' })).map(p => p.postId)).toEqual([
      societyPost.postId,
    ]);
    expect((await listMemberBulletinFeed(db, member.member_id, { scope: 'project' })).map(p => p.postId)).toEqual([
      projectPost.postId,
    ]);
    expect(
      (await listMemberBulletinFeed(db, member.member_id, { scope: 'all', projectId: project.project_id })).map(
        p => p.postId,
      ),
    ).toEqual([projectPost.postId]);
  });
});
