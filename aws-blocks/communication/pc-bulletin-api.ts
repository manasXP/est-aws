// STR-134: the mobile Public API's `/pc` bulletin write -- the PC surface's
// single write (Governance & Roles' PC system-access decision is read-only
// "except one write: posting to the PC's own project bulletin board").
//
// The PC-side mirror of bulletin-posts-routes.ts, with one deliberate
// difference: there is **no capability** anywhere in this module. The same
// governance decision that grants this write says "PCs still get no
// admin-panel capability", so the gate is a direct current-seat lookup
// (`isPcMember`, the same one pc-documents-routes.ts and pc-assets-routes.ts
// use) rather than STR-044's capability registry (AC4).
//
// Both handlers are thin adapters over STR-131's bulletin-posts.ts: the
// authorship rule, the edit audit and the archived-post refusal all live
// there and are called, never restated here.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import {
  createBulletinPost,
  getBulletinPost,
  editBulletinPost,
  BulletinPostValidationError,
  BulletinPostAuthorityError,
  BulletinPostConflictError,
  type DocumentLookupPort,
} from './bulletin-posts';
import { toMobileBulletinPostResponse } from './bulletin-mobile-api';
import { isPcMember } from '../assets/asset-visibility';
import { getProject } from '../projects/projects-api';
import { getDocumentMetadata } from '../documents/documents-api';
import {
  sendNotFound,
  sendValidationError,
  sendConflictError,
  sendCapabilityRequired,
  sendUnauthorized,
} from '../http/problem-response';

/**
 * STR-131's document-lookup port, narrowed to what the contract allows a PC
 * to attach: "existing project-level registry documents" **of this project**
 * (AC2, TC-COM-007). A society- or member-level document, or a project
 * document belonging to a different project, is not attachable here -- the
 * PC governs one project, and this is the only surface that can attach on
 * its behalf.
 */
export function projectDocumentLookup(projectId: string): DocumentLookupPort {
  return async (db, documentId) => {
    const doc = await getDocumentMetadata(db, documentId);
    return doc !== null && doc.level === 'project' && doc.projectId === projectId;
  };
}

export function registerPcBulletinRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'create-pc-bulletin-post', {
    method: 'POST',
    path: '/v1/pc/projects/{projectId}/posts',
    handler: async ctx => {
      const { projectId } = ctx.request.params;
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      // Project-not-found before the seat gate, matching
      // pc-documents-routes.ts: a project that doesn't exist has no PC to
      // sit on, so 404 is the honest answer.
      if (!(await getProject(db, projectId))) {
        sendNotFound(ctx, `No project ${projectId}`);
        return;
      }
      if (!(await isPcMember(db, projectId, memberId))) {
        sendCapabilityRequired(ctx, 'pc-member');
        return;
      }

      const body = await ctx.request.json();
      try {
        // `scope: 'project'` and the project id both come from the path,
        // never from the body: this route can only ever write to the board
        // the gate above just cleared (AC1).
        const post = await createBulletinPost(
          db,
          memberId,
          {
            scope: 'project',
            project_id: projectId,
            title: body?.title,
            body: body?.body,
            attachments: body?.attachment_document_ids,
            pinned: body?.pinned,
          },
          { documentLookup: projectDocumentLookup(projectId) },
        );
        ctx.response.status = 201;
        ctx.response.send(await toMobileBulletinPostResponse(db, post));
      } catch (e) {
        // A seat vacated between the gate and the insert: the domain's own
        // authority check is the last word, and it means the same thing.
        if (e instanceof BulletinPostAuthorityError) {
          sendCapabilityRequired(ctx, 'pc-member');
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

  new RawRoute(scope, 'update-pc-bulletin-post', {
    method: 'PATCH',
    path: '/v1/pc/posts/{postId}',
    handler: async ctx => {
      const { postId } = ctx.request.params;
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      const existing = await getBulletinPost(db, postId);
      // A society post is 404 here, not 403: this surface does not govern
      // the society board at all, so its posts are simply not addressable
      // through it (the contract's "404 for society posts").
      if (!existing || existing.scope !== 'project') {
        sendNotFound(ctx, `No bulletin post ${postId}`);
        return;
      }
      // Authority is re-derived from the post's own project, never from the
      // caller's claim -- and from *current* seats, so a vacated seat ends
      // the write (T-U4).
      if (!(await isPcMember(db, existing.projectId!, memberId))) {
        sendCapabilityRequired(ctx, 'pc-member');
        return;
      }

      const body = await ctx.request.json();
      try {
        // Content only: `pinned` and `attachment_document_ids` are dropped,
        // the way STR-131's content-only patch defines an edit.
        const post = await editBulletinPost(db, postId, memberId, {
          ...(body?.title !== undefined && { title: body.title }),
          ...(body?.body !== undefined && { body: body.body }),
        });
        if (!post) {
          sendNotFound(ctx, `No bulletin post ${postId}`);
          return;
        }
        ctx.response.send(await toMobileBulletinPostResponse(db, post));
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
}
