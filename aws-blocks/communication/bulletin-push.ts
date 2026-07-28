// STR-133: the new-post push (TC-COM-003). Registers onto STR-131's
// `bulletinPostPublishedListeners` hook, so every publish path in E14 --
// STR-132's EC compose, STR-134's PC compose -- gets push with no code
// change of its own.
//
// No new push infrastructure: the audience is bulletin-audience.ts's
// function (the same one the feed reads, AC3) and delivery is STR-067's
// `PushAdapter` over its `registered_devices` store, unchanged. No
// push-provider SDK type appears here.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import type { PushAdapter, PushNotification } from '../notifications/push-adapter';
import { pgTextArray } from '../sql-array';
import { bulletinPostPublishedListeners, type BulletinPostPublishedEvent } from './bulletin-posts';
import { resolveBulletinBoardAudience } from './bulletin-audience';

/** The deep-link target of the notification: the Mobile OpenAPI's
 * `GET /me/bulletin/{postId}`, which exists precisely to be this. */
export function bulletinPostDeepLink(postId: string): string {
  return `/me/bulletin/${postId}`;
}

/**
 * One push per registered device of every member on the published post's
 * board (AC3). A targeted member with no registered device simply
 * contributes no row to the device query -- no send, no error (AC4), the
 * same fail-soft STR-067's reminder dispatch has.
 */
export async function dispatchBulletinPostPush(
  db: Database,
  adapter: PushAdapter,
  event: BulletinPostPublishedEvent,
): Promise<void> {
  const audience = await resolveBulletinBoardAudience(db, event.scope, event.projectId);
  if (audience.length === 0) return;

  const devices = await db.query<{ push_token: string }>(
    sql`SELECT push_token FROM registered_devices WHERE member_id = ANY(${pgTextArray(audience)}::text[])`,
  );

  const notification: PushNotification = {
    title: 'New bulletin post',
    body: 'A new announcement has been posted -- open the app to read it.',
    deepLink: bulletinPostDeepLink(event.postId),
  };
  for (const device of devices) {
    await adapter.send(device.push_token, notification);
  }
}

/** Wires the dispatch onto the publish event. Called once at app wiring
 * (aws-blocks/index.ts) and once per test that exercises the push. */
export function registerBulletinPushListener(db: Database, adapter: PushAdapter): void {
  bulletinPostPublishedListeners.push(event => dispatchBulletinPostPush(db, adapter, event));
}
