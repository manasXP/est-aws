// STR-132: the Admin API bulletin-post surface -- list/read across both
// boards, EC compose and edit on the society board, and archive moderation
// that spans society and project boards alike. A thin HTTP adapter over
// STR-131's bulletin-posts.ts: every rule that could be violated twice (the
// archive-never-delete flip, the edit audit, the archived-post refusal)
// lives there and is called, never restated here.
//
// The two authority halves are deliberately different capabilities:
// `bulletin_compose` (EC office only) carries authorship of a society post,
// `bulletin_moderate` (Management or EC) carries take-down of any post. That
// is why archive reaches project boards this surface can neither create nor
// edit -- a PC's post is theirs to write and edit (STR-134's `/pc` route),
// and only theirs.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import {
  createBulletinPost,
  getBulletinPost,
  listBulletinPosts,
  editBulletinPost,
  archiveBulletinPost,
  BulletinPostValidationError,
  BulletinPostAuthorityError,
  BulletinPostConflictError,
  type BulletinPostRecord,
  type BulletinScope,
} from './bulletin-posts';
import { getMember } from '../members/members-api';
import { getDocumentMetadata } from '../documents/documents-api';
import {
  sendNotFound,
  sendValidationError,
  sendConflictError,
  sendCapabilityRequired,
  ConflictError,
} from '../http/problem-response';
import { requireCapability, resolveActor } from '../http/capability-gate';

// The Admin OpenAPI's BulletinPost schema carries the author's name and each
// attachment's title -- neither is on the entity itself (STR-131 stores ids,
// the registry owns the title), so both are resolved here at read time.
async function toBulletinPostResponse(db: Database, post: BulletinPostRecord): Promise<Record<string, unknown>> {
  // Non-null: `author_member_id` is a NOT NULL FK into `members`.
  const author = (await getMember(db, post.authorMemberId))!;
  const attachments: Array<{ document_id: string; title: string }> = [];
  for (const documentId of post.attachments) {
    const document = await getDocumentMetadata(db, documentId);
    attachments.push({ document_id: documentId, title: document?.title ?? documentId });
  }
  return {
    post_id: post.postId,
    scope: post.scope,
    project_id: post.projectId,
    author: { member_id: post.authorMemberId, name: author.name },
    title: post.title,
    body: post.body,
    pinned: post.pinned,
    status: post.archived ? 'archived' : 'active',
    attachments,
    posted_at: post.postedAt,
    edited_at: post.editedAt,
  };
}

/**
 * The acting member for a write. `requireCapability` has already passed by
 * the time this is consulted, so the only caller it turns away is an
 * employee holding the capability: authorship and the edit audit are member
 * identities (`author_member_id`/`editor_member_id` are FKs into `members`),
 * which an employee account has none of.
 */
function actingMemberId(ctx: Parameters<typeof resolveActor>[0]): string | null {
  const actor = resolveActor(ctx);
  return actor && 'memberId' in actor ? actor.memberId : null;
}

export function registerBulletinPostRoutes(scope: Scope, db: Database): void {
  // Ungated, like every other Admin read surface in this repo -- and the
  // contract agrees: the two GET operations declare no 403 at all, while
  // POST/PATCH/archive each do.
  new RawRoute(scope, 'list-bulletin-posts', {
    method: 'GET',
    path: '/v1/bulletin-posts',
    handler: async ctx => {
      const params = ctx.request.url.searchParams;
      const scopeParam = params.get('scope') ?? 'all';
      try {
        if (scopeParam !== 'society' && scopeParam !== 'project' && scopeParam !== 'all') {
          throw new BulletinPostValidationError('scope must be one of society, project, all.');
        }
        const posts = await listBulletinPosts(db, {
          scope: scopeParam as BulletinScope | 'all',
          projectId: params.get('project_id'),
          includeArchived: params.get('include_archived') === 'true',
        });
        const items = [];
        for (const post of posts) {
          items.push(await toBulletinPostResponse(db, post));
        }
        // `cursor`/`limit` are accepted per the contract but `next_cursor` is
        // always null -- the STR-051 precedent; no story has built real
        // cursoring yet.
        ctx.response.send({ items, next_cursor: null });
      } catch (e) {
        if (e instanceof BulletinPostValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'create-bulletin-post', {
    method: 'POST',
    path: '/v1/bulletin-posts',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'bulletin_compose'))) return;
      const authorMemberId = actingMemberId(ctx);
      if (!authorMemberId) {
        sendCapabilityRequired(ctx, 'bulletin_compose');
        return;
      }

      const body = await ctx.request.json();
      try {
        // `scope: 'society'` is fixed, never read from the body: a project
        // post is created by its PC on the mobile /pc surface and nowhere
        // else (Communication, and this story's AC1).
        const post = await createBulletinPost(db, authorMemberId, {
          scope: 'society',
          title: body?.title,
          body: body?.body,
          attachments: body?.attachment_document_ids,
          pinned: body?.pinned,
        });
        ctx.response.status = 201;
        ctx.response.send(await toBulletinPostResponse(db, post));
      } catch (e) {
        // An EC office vacated between the claims read and the insert: the
        // domain's own authority check is the last word, and it means the
        // same thing the gate does.
        if (e instanceof BulletinPostAuthorityError) {
          sendCapabilityRequired(ctx, 'bulletin_compose');
          return;
        }
        if (e instanceof BulletinPostValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-bulletin-post', {
    method: 'GET',
    path: '/v1/bulletin-posts/{postId}',
    handler: async ctx => {
      const { postId } = ctx.request.params;
      const post = await getBulletinPost(db, postId);
      if (!post) {
        sendNotFound(ctx, `No bulletin post ${postId}`);
        return;
      }
      ctx.response.send(await toBulletinPostResponse(db, post));
    },
  });

  new RawRoute(scope, 'update-bulletin-post', {
    method: 'PATCH',
    path: '/v1/bulletin-posts/{postId}',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'bulletin_compose'))) return;
      const editorMemberId = actingMemberId(ctx);
      if (!editorMemberId) {
        sendCapabilityRequired(ctx, 'bulletin_compose');
        return;
      }

      const { postId } = ctx.request.params;
      const existing = await getBulletinPost(db, postId);
      if (!existing) {
        sendNotFound(ctx, `No bulletin post ${postId}`);
        return;
      }
      // AC2: a project post belongs to its PC. This is the whole of the
      // check -- the archived-post refusal below is STR-131's, not a second
      // copy of it here.
      if (existing.scope !== 'society') {
        sendConflictError(
          ctx,
          new ConflictError(`Post ${postId} is a project post; it is edited by its PC on the mobile /pc surface.`),
        );
        return;
      }

      const body = await ctx.request.json();
      try {
        // Content only: `pinned` and `attachment_document_ids` are dropped,
        // the way STR-131's content-only patch defines an edit.
        const post = await editBulletinPost(db, postId, editorMemberId, {
          ...(body?.title !== undefined && { title: body.title }),
          ...(body?.body !== undefined && { body: body.body }),
        });
        if (!post) {
          sendNotFound(ctx, `No bulletin post ${postId}`);
          return;
        }
        ctx.response.send(await toBulletinPostResponse(db, post));
      } catch (e) {
        if (e instanceof BulletinPostConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof BulletinPostValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'archive-bulletin-post', {
    method: 'POST',
    path: '/v1/bulletin-posts/{postId}/archive',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'bulletin_moderate'))) return;
      const { postId } = ctx.request.params;
      const post = await archiveBulletinPost(db, postId);
      if (!post) {
        sendNotFound(ctx, `No bulletin post ${postId}`);
        return;
      }
      ctx.response.send(await toBulletinPostResponse(db, post));
    },
  });
}
