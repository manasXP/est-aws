// STR-133: the one computation behind both halves of E14's visibility rule
// (Communication, "Visible to"):
//
//   society board -> every member with app access (`active`/`suspended`)
//   project board -> current owners in the project (E06) + its current PC
//                    seat holders (STR-043)
//
// The mobile feed and the new-post push audience are the *same* rule read
// from opposite sides, so they are the same function here rather than two
// implementations that can drift (AC3). `resolveMemberBulletinBoards` is
// literally the inverse: it enumerates the candidate boards and keeps the
// ones whose `resolveBulletinBoardAudience` contains the caller. That is
// what makes "provably the same function" structural instead of a
// convention -- there is no second membership predicate anywhere.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { listBulletinPosts, type BulletinPostRecord, type BulletinScope } from './bulletin-posts';

/** One bulletin board. `projectId` is null on the society board and set on
 * every project board -- the same pairing `bulletin_posts` constrains. */
export interface BulletinBoard {
  scope: BulletinScope;
  projectId: string | null;
}

/**
 * Every member the board `scope`/`projectId` identifies is visible to
 * (TC-COM-001, TC-COM-003). Ids only -- both callers need nothing else, and
 * the society board on a large society is a long list.
 *
 * App access is `active` *and* `suspended` (Communication's visibility
 * table, and AC4): a suspended member keeps the announcements, they only
 * lose entitlements.
 */
export async function resolveBulletinBoardAudience(
  db: Database,
  scope: BulletinScope,
  projectId: string | null,
): Promise<string[]> {
  if (scope === 'society') {
    const rows = await db.query<{ id: string }>(
      sql`SELECT id FROM members WHERE member_status IN ('active', 'suspended') ORDER BY id`,
    );
    return rows.map(row => row.id);
  }

  // Owners are joined through `assets` (an ownership names an asset, and the
  // asset names the project) and restricted to open ownerships -- a member
  // who transferred away their last unit in the project is no longer on its
  // board (STR-055's `closed_at IS NULL` means "current").
  const rows = await db.query<{ member_id: string }>(sql`
    SELECT o.member_id FROM ownerships o
      JOIN assets a ON a.id = o.asset_id
      WHERE a.project_id = ${projectId} AND o.closed_at IS NULL
    UNION
    SELECT s.member_id FROM project_committee_seats s
      JOIN project_committees c ON c.id = s.committee_id
      WHERE c.project_id = ${projectId} AND s.effective_to IS NULL
    ORDER BY member_id`);
  return rows.map(row => row.member_id);
}

/**
 * The inverse read: every board `memberId` is in the audience of. Enumerates
 * the candidate boards -- the society board plus one per project -- and
 * keeps those whose audience contains the caller. Deliberately not a second,
 * "cleverer" query: reusing the audience function is what AC3 asks for, and
 * a single society's project count is small.
 */
export async function resolveMemberBulletinBoards(db: Database, memberId: string): Promise<BulletinBoard[]> {
  const candidates: BulletinBoard[] = [{ scope: 'society', projectId: null }];
  for (const row of await db.query<{ id: string }>(sql`SELECT id FROM projects ORDER BY id`)) {
    candidates.push({ scope: 'project', projectId: row.id });
  }

  const boards: BulletinBoard[] = [];
  for (const board of candidates) {
    if ((await resolveBulletinBoardAudience(db, board.scope, board.projectId)).includes(memberId)) {
      boards.push(board);
    }
  }
  return boards;
}

export interface BulletinFeedFilters {
  /** The Mobile OpenAPI's `scope` query parameter; `all` is its default. */
  scope?: BulletinScope | 'all';
  /** The Mobile OpenAPI's `project_id` query parameter. */
  projectId?: string | null;
}

/**
 * `GET /me/bulletin` (AC1, AC2, TC-COM-002): the member's boards, pinned
 * first then newest, archived excluded. The board set is
 * `resolveMemberBulletinBoards` and nothing else -- a filter can only narrow
 * within it, never reach a board the member is not on.
 */
export async function listMemberBulletinFeed(
  db: Database,
  memberId: string,
  filters: BulletinFeedFilters = {},
): Promise<BulletinPostRecord[]> {
  const scope = filters.scope ?? 'all';
  const projectId = filters.projectId ?? null;

  const boards = (await resolveMemberBulletinBoards(db, memberId)).filter(
    board =>
      (scope === 'all' || board.scope === scope) && (projectId === null || board.projectId === projectId),
  );

  // One read per board, re-sorted across them: `listBulletinPosts` already
  // owns the pinned-first/newest-next order and the archived exclusion
  // (STR-131), so the feed restates neither.
  const posts: BulletinPostRecord[] = [];
  for (const board of boards) {
    posts.push(...(await listBulletinPosts(db, { scope: board.scope, projectId: board.projectId })));
  }
  return posts.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.postedAt) - Date.parse(a.postedAt),
  );
}
