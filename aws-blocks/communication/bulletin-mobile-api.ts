// STR-133: the mobile Public API's bulletin surface -- the feed, the
// single-post deep-link target of the new-post push, and the presigned
// download of a post attachment. A thin HTTP adapter, the shape
// bulletin-posts-routes.ts (the admin half) established: the visibility rule
// lives in bulletin-audience.ts and is called, never restated here.
//
// Every one of the three routes answers "is the caller on this post's
// board?" with `resolveBulletinBoardAudience` -- the same function the push
// dispatch resolves its audience with (AC3). Caller identity comes from the
// `X-Actor-Member-Id` stub header, the convention
// aws-blocks/assets/me-ownerships-routes.ts established for `/me`.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import { getBulletinPost, type BulletinPostRecord, type BulletinScope } from './bulletin-posts';
import { listMemberBulletinFeed, resolveBulletinBoardAudience } from './bulletin-audience';
import { getMember } from '../members/members-api';
import { getProject } from '../projects/projects-api';
import { getDocumentMetadata, getDownloadUrl, DOWNLOAD_URL_EXPIRES_IN_SECONDS } from '../documents/documents-api';
import { sendNotFound, sendUnauthorized } from '../http/problem-response';

// The Mobile OpenAPI's BulletinPost schema: the author's name, the project's
// name and each attachment's registry title/file name are all resolved at
// read time -- the entity itself stores only ids (STR-131).
async function toBulletinPostResponse(db: Database, post: BulletinPostRecord): Promise<Record<string, unknown>> {
  // Non-null: `author_member_id` is a NOT NULL FK into `members`.
  const author = (await getMember(db, post.authorMemberId))!;
  const project = post.projectId === null ? null : await getProject(db, post.projectId);
  const attachments: Array<{ document_id: string; title: string; file_name: string }> = [];
  for (const documentId of post.attachments) {
    const document = await getDocumentMetadata(db, documentId);
    attachments.push({
      document_id: documentId,
      title: document?.title ?? documentId,
      file_name: document?.fileName ?? documentId,
    });
  }
  return {
    post_id: post.postId,
    scope: post.scope,
    project_id: post.projectId,
    project_name: project?.name ?? null,
    author: { member_id: post.authorMemberId, name: author.name },
    title: post.title,
    body: post.body,
    pinned: post.pinned,
    attachments,
    posted_at: post.postedAt,
    edited_at: post.editedAt,
  };
}

/**
 * The post a `/me/bulletin` read may see: it exists, it is not archived, and
 * the caller is in its board's audience. All three collapse to the contract's
 * single 404 ("Post does not exist, is archived, or is outside the member's
 * boards") on purpose -- an outsider must not be able to tell a post they
 * cannot see from one that isn't there.
 */
async function visiblePost(db: Database, memberId: string, postId: string): Promise<BulletinPostRecord | null> {
  const post = await getBulletinPost(db, postId);
  if (!post || post.archived) return null;
  const audience = await resolveBulletinBoardAudience(db, post.scope, post.projectId);
  return audience.includes(memberId) ? post : null;
}

export function registerMeBulletinRoutes(scope: Scope, db: Database, bucket: FileBucket): void {
  new RawRoute(scope, 'list-me-bulletin', {
    method: 'GET',
    path: '/v1/me/bulletin',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      const params = ctx.request.url.searchParams;
      const scopeParam = params.get('scope') ?? 'all';
      const posts = await listMemberBulletinFeed(db, memberId, {
        scope: scopeParam as BulletinScope | 'all',
        projectId: params.get('project_id'),
      });
      const items = [];
      for (const post of posts) {
        items.push(await toBulletinPostResponse(db, post));
      }
      // `cursor`/`limit` are accepted per the contract but `next_cursor` is
      // always null -- the STR-051 precedent; no story has built real
      // cursoring yet.
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'get-me-bulletin-post', {
    method: 'GET',
    path: '/v1/me/bulletin/{postId}',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      const { postId } = ctx.request.params;
      const post = await visiblePost(db, memberId, postId);
      if (!post) {
        sendNotFound(ctx, `No bulletin post ${postId}`);
        return;
      }
      ctx.response.send(await toBulletinPostResponse(db, post));
    },
  });

  new RawRoute(scope, 'download-me-bulletin-attachment', {
    method: 'GET',
    path: '/v1/me/bulletin/{postId}/attachments/{documentId}',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      const { postId, documentId } = ctx.request.params;
      // Presign only after the post is established as visible AND the
      // document as attached to *that* post -- a registry id the member
      // could otherwise not reach is not reachable by naming any post of
      // theirs (the STR-124 attachment-leak mitigation shape).
      const post = await visiblePost(db, memberId, postId);
      if (!post || !post.attachments.includes(documentId)) {
        sendNotFound(ctx, `No attachment ${documentId} on bulletin post ${postId}`);
        return;
      }

      const url = await getDownloadUrl(db, bucket, documentId);
      if (!url) {
        sendNotFound(ctx, `No attachment ${documentId} on bulletin post ${postId}`);
        return;
      }
      const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();
      ctx.response.send({ url, expires_at: expiresAt });
    },
  });
}
