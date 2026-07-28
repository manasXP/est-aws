// STR-131: the BulletinPost foundation (Communication spec) -- the E14
// entity, its posting-authority rule, and the archive-never-delete
// invariant. No HTTP surface of its own: STR-132 (admin compose +
// cross-board moderation) and STR-134 (the mobile `/pc` write) assemble
// these functions behind their own routes, the same shape STR-071 shipped a
// pure allocator for its siblings. Kept separate from any route module so
// it's testable with a plain Database.
//
// "Posts are archived, never deleted" (Communication, bundle-wide rule) is
// structural, not a convention: there is no DELETE statement in this module
// or in migrations/043_bulletin_posts.sql.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { hasCurrentEcOffice } from '../members/role-assignments';
import { isPcMember } from '../assets/asset-visibility';
import { getDocumentMetadata } from '../documents/documents-api';

export type BulletinScope = 'society' | 'project';

/** The BulletinPost entity (Communication: post_id, scope/project_id,
 * author, title/body, attachments, pinned, posted_at/edited_at). */
export interface BulletinPostRecord {
  postId: string;
  scope: BulletinScope;
  /** Always null on society posts, always set on project posts. */
  projectId: string | null;
  /** The individual EC/PC member who posted -- never rewritten (AC3). */
  authorMemberId: string;
  title: string;
  body: string;
  /** Document-registry ids (Communication: attachments go via the registry). */
  attachments: string[];
  pinned: boolean;
  postedAt: string;
  /** Both null until the first edit -- edits are audited. */
  editorMemberId: string | null;
  editedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
}

export interface CreateBulletinPostInput {
  scope: BulletinScope;
  project_id?: string | null;
  title: string;
  body: string;
  attachments?: string[];
  pinned?: boolean;
}

/** Content patch for `editBulletinPost`. Deliberately content-only:
 * attachments are not editable in this story, so no path here needs to
 * remove an attachment row (the archive-never-delete rule, applied to the
 * link table too). */
export interface BulletinPostPatch {
  title?: string;
  body?: string;
}

/**
 * Document-registry existence check for attachment ids. Injectable so this
 * module's tests can drive attachment validation with a fake (the STR-043
 * ownership-lookup pattern) without standing up the E12 registry; the
 * default is the real registry lookup.
 */
export type DocumentLookupPort = (db: Database, documentId: string) => Promise<boolean>;

export const registryDocumentLookup: DocumentLookupPort = async (db, documentId) =>
  (await getDocumentMetadata(db, documentId)) !== null;

/** Domain rejection for a malformed post (blank title/body, a scope that
 * doesn't match its project_id, an attachment the registry doesn't know).
 * Nothing is written when this is thrown. */
export class BulletinPostValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'BulletinPostValidationError';
  }
}

/**
 * Refusal for an author whose committee seat doesn't carry authority over
 * the board they're posting to (AC1, TC-COM-005). A distinct class rather
 * than a ValidationError: the request is well-formed, the author simply
 * isn't entitled, so STR-132/134's routes map this to 403 -- not the 422
 * that problem-response.ts gives every ValidationError.
 */
export class BulletinPostAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulletinPostAuthorityError';
  }
}

/** Domain rejection for editing a post that has already been archived --
 * the shared guard STR-132's moderation surface and STR-134's PC write both
 * call through (409). */
export class BulletinPostConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'BulletinPostConflictError';
  }
}

export interface BulletinPostPublishedEvent {
  postId: string;
  scope: BulletinScope;
  projectId: string | null;
  authorMemberId: string;
}

/**
 * Listeners called by createBulletinPost after its INSERT, inside the same
 * transaction -- the STR-032 -> STR-041 event-seam shape (members-api.ts's
 * `memberStatusTransitionListeners`). Empty in this story (AC4: publishing
 * needs no listener to succeed); STR-133 registers the push-dispatch
 * listener here without this module depending on it.
 */
export const bulletinPostPublishedListeners: Array<
  (event: BulletinPostPublishedEvent, tx: Transaction) => Promise<void>
> = [];

interface BulletinPostRow {
  id: string;
  scope: BulletinScope;
  project_id: string | null;
  author_member_id: string;
  title: string;
  body: string;
  pinned: boolean;
  posted_at: string | Date;
  editor_member_id: string | null;
  edited_at: string | Date | null;
  archived: boolean;
  archived_at: string | Date | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPost(row: BulletinPostRow, attachments: string[]): BulletinPostRecord {
  return {
    postId: row.id,
    scope: row.scope,
    projectId: row.project_id,
    authorMemberId: row.author_member_id,
    title: row.title,
    body: row.body,
    attachments,
    pinned: row.pinned,
    postedAt: toIso(row.posted_at),
    editorMemberId: row.editor_member_id,
    editedAt: row.edited_at === null ? null : toIso(row.edited_at),
    archived: row.archived,
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
  };
}

async function attachmentsOf(db: Database, postId: string): Promise<string[]> {
  const rows = await db.query<{ document_id: string }>(
    sql`SELECT document_id FROM bulletin_post_attachments WHERE post_id = ${postId} ORDER BY document_id`,
  );
  return rows.map(row => row.document_id);
}

/** A single post by id, or null if there is none. */
export async function getBulletinPost(db: Database, postId: string): Promise<BulletinPostRecord | null> {
  const row = await db.queryOne<BulletinPostRow>(sql`SELECT * FROM bulletin_posts WHERE id = ${postId}`);
  return row ? toPost(row, await attachmentsOf(db, postId)) : null;
}

/**
 * Whether `authorMemberId` may post to the board `scope`/`projectId`
 * identifies (AC1). The two halves are deliberately independent: an EC
 * office carries the society board and nothing else, a PC seat carries that
 * one project board and nothing else (Communication's Rules -- and
 * Governance & Roles' "PC seats confer no admin capability").
 */
export async function canPostToBoard(
  db: Database,
  authorMemberId: string,
  scope: BulletinScope,
  projectId: string | null,
): Promise<boolean> {
  return scope === 'society'
    ? hasCurrentEcOffice(db, authorMemberId)
    : isPcMember(db, projectId!, authorMemberId);
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BulletinPostValidationError(`${field} is required.`);
  }
  return value;
}

export interface CreateBulletinPostOptions {
  documentLookup?: DocumentLookupPort;
}

/**
 * Publishes a post to the society or a project board (AC1, AC4,
 * TC-COM-005). Rejects -- writing nothing -- if the scope/project_id pairing
 * or the content is malformed (BulletinPostValidationError), if the author's
 * current committee seats don't carry the board (BulletinPostAuthorityError),
 * or if any attachment id is unknown to the document registry
 * (BulletinPostValidationError).
 *
 * Authority is resolved from *current* seats at post time only; the
 * `author_member_id` written here is never revisited afterwards, which is
 * what keeps AC3's two rules ("no new posts" / "old attribution stands")
 * from collapsing into each other.
 */
export async function createBulletinPost(
  db: Database,
  authorMemberId: string,
  input: CreateBulletinPostInput,
  opts: CreateBulletinPostOptions = {},
): Promise<BulletinPostRecord> {
  if (input.scope !== 'society' && input.scope !== 'project') {
    throw new BulletinPostValidationError("scope must be 'society' or 'project'.");
  }
  const projectId = input.project_id ?? null;
  if (input.scope === 'society' && projectId !== null) {
    throw new BulletinPostValidationError('A society-scope post must not carry a project_id.');
  }
  if (input.scope === 'project' && projectId === null) {
    throw new BulletinPostValidationError('A project-scope post requires a project_id.');
  }
  const title = requireNonBlank(input.title, 'title');
  const body = requireNonBlank(input.body, 'body');

  if (!(await canPostToBoard(db, authorMemberId, input.scope, projectId))) {
    throw new BulletinPostAuthorityError(
      input.scope === 'society'
        ? `Member ${authorMemberId} holds no current EC office; the society board is EC-only.`
        : `Member ${authorMemberId} holds no current PC seat on project ${projectId}.`,
    );
  }

  const attachments = input.attachments ?? [];
  const documentLookup = opts.documentLookup ?? registryDocumentLookup;
  for (const documentId of attachments) {
    if (!(await documentLookup(db, documentId))) {
      throw new BulletinPostValidationError(`No document found with id: ${documentId}`);
    }
  }

  const postId = randomUUID();
  await db.transaction(async tx => {
    await tx.execute(
      sql`INSERT INTO bulletin_posts (id, scope, project_id, author_member_id, title, body, pinned)
          VALUES (${postId}, ${input.scope}, ${projectId}, ${authorMemberId}, ${title}, ${body}, ${input.pinned ?? false})`,
    );
    for (const documentId of attachments) {
      await tx.execute(
        sql`INSERT INTO bulletin_post_attachments (post_id, document_id) VALUES (${postId}, ${documentId})`,
      );
    }
    for (const listener of bulletinPostPublishedListeners) {
      await listener({ postId, scope: input.scope, projectId, authorMemberId }, tx);
    }
  });

  return (await getBulletinPost(db, postId))!;
}

/**
 * Moderation take-down (AC2, TC-COM-004): flips `archived`/`archived_at` so
 * the post drops out of active board reads, and does nothing else -- the row
 * stays, and `pinned` is left exactly as it was. Idempotent: re-archiving
 * keeps the first `archived_at`. Returns null if there is no such post.
 */
export async function archiveBulletinPost(db: Database, postId: string): Promise<BulletinPostRecord | null> {
  await db.execute(
    sql`UPDATE bulletin_posts SET archived = true, archived_at = COALESCE(archived_at, now()) WHERE id = ${postId}`,
  );
  return getBulletinPost(db, postId);
}

/**
 * Sets the `pinned` flag (AC2). Independent of `archived` in both
 * directions -- pinning is not a lifecycle state -- and not a content edit,
 * so it leaves `editor_member_id`/`edited_at` untouched. Returns null if
 * there is no such post.
 */
export async function setBulletinPostPinned(
  db: Database,
  postId: string,
  pinned: boolean,
): Promise<BulletinPostRecord | null> {
  await db.execute(sql`UPDATE bulletin_posts SET pinned = ${pinned} WHERE id = ${postId}`);
  return getBulletinPost(db, postId);
}

/**
 * Audited content edit: stamps `editor_member_id`/`edited_at` (the editor,
 * who need not be the author -- attribution is never rewritten). Rejects
 * with BulletinPostConflictError on an already-archived post; that guard is
 * the reason this lives here rather than in either route module, since
 * STR-132 and STR-134 must refuse identically. Returns null if there is no
 * such post. Caller authority is the route layer's gate (canPostToBoard).
 */
export async function editBulletinPost(
  db: Database,
  postId: string,
  editorMemberId: string,
  patch: BulletinPostPatch,
): Promise<BulletinPostRecord | null> {
  const existing = await getBulletinPost(db, postId);
  if (!existing) return null;
  if (existing.archived) {
    throw new BulletinPostConflictError(`Post ${postId} is archived and can no longer be edited.`);
  }

  const title = patch.title === undefined ? existing.title : requireNonBlank(patch.title, 'title');
  const body = patch.body === undefined ? existing.body : requireNonBlank(patch.body, 'body');

  // The `AND archived = false` guard is the DB-level backstop for the
  // read-then-write race above: an archive committing between the two would
  // otherwise let this edit land on an archived post. Same shape as
  // members-api.ts's transitionMemberStatus guard.
  const { rowCount } = await db.execute(
    sql`UPDATE bulletin_posts SET title = ${title}, body = ${body}, editor_member_id = ${editorMemberId}, edited_at = now()
        WHERE id = ${postId} AND archived = false`,
  );
  if (rowCount === 0) {
    throw new BulletinPostConflictError(`Post ${postId} is archived and can no longer be edited.`);
  }

  return getBulletinPost(db, postId);
}

export interface ListBulletinPostsFilters {
  scope: BulletinScope;
  /** Required for `scope: 'project'` -- one board per project. */
  projectId?: string | null;
  /** Off by default: the active board read is what AC2's "archiving hides
   * the post" means. Moderation surfaces (STR-132) pass true. */
  includeArchived?: boolean;
}

/**
 * One board's posts, pinned first then newest first (Communication:
 * "`pinned` keeps a post at the top of its board"). Archived posts are
 * filtered out of the read, never removed from the table (AC2).
 */
export async function listBulletinPosts(
  db: Database,
  filters: ListBulletinPostsFilters,
): Promise<BulletinPostRecord[]> {
  const projectId = filters.projectId ?? null;
  if (filters.scope === 'project' && projectId === null) {
    throw new BulletinPostValidationError('projectId is required to read a project board.');
  }

  const rows = await db.query<BulletinPostRow>(
    filters.scope === 'society'
      ? filters.includeArchived
        ? sql`SELECT * FROM bulletin_posts WHERE scope = 'society' ORDER BY pinned DESC, posted_at DESC`
        : sql`SELECT * FROM bulletin_posts WHERE scope = 'society' AND archived = false ORDER BY pinned DESC, posted_at DESC`
      : filters.includeArchived
        ? sql`SELECT * FROM bulletin_posts WHERE scope = 'project' AND project_id = ${projectId} ORDER BY pinned DESC, posted_at DESC`
        : sql`SELECT * FROM bulletin_posts WHERE scope = 'project' AND project_id = ${projectId} AND archived = false ORDER BY pinned DESC, posted_at DESC`,
  );

  const posts: BulletinPostRecord[] = [];
  for (const row of rows) {
    posts.push(toPost(row, await attachmentsOf(db, row.id)));
  }
  return posts;
}
