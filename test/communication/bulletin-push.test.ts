import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { FakePushAdapter } from '../../aws-blocks/notifications/push-adapter';
import { createMember, admitMember, suspendMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee, type ProjectOwnershipLookupPort } from '../../aws-blocks/projects/committees-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { createBulletinPost, bulletinPostPublishedListeners } from '../../aws-blocks/communication/bulletin-posts';
import { resolveBulletinBoardAudience } from '../../aws-blocks/communication/bulletin-audience';
import { registerBulletinPushListener } from '../../aws-blocks/communication/bulletin-push';

// STR-133 — the new-post push. Registers onto STR-131's
// `bulletinPostPublishedListeners` hook and sends through STR-067's
// PushAdapter/registered_devices store; the audience is
// test/communication/bulletin-feed.test.ts's function, read from the other
// side (AC3).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-133-push-test-${randomUUID()}`), 'db');
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

async function activeMember(db: Database, name: string) {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  return member;
}

async function ecMember(db: Database, name: string) {
  const member = await activeMember(db, name);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'admin-1');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'admin-1');
  return member;
}

function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

async function seatOnPc(db: Database, projectId: string, memberIds: string[]) {
  await setProjectCommittee(
    db,
    projectId,
    { chair_member_id: memberIds[0], member_ids: memberIds },
    { ownershipLookup: ownershipAmong(memberIds.map(id => [id, projectId] as [string, string])) },
  );
}

async function ownInProject(db: Database, projectId: string, memberId: string, label: string) {
  const asset = await createAsset(db, { project_id: projectId, type: 'flat', label });
  return createOwnership(db, memberId, { asset_id: asset.asset_id });
}

/** No `/me/devices` endpoint exists yet (ships with the mobile milestone,
 * E16/E17) — tests seed registered_devices rows directly, the STR-067
 * precedent. */
async function registerDevice(db: Database, memberId: string, platform: 'ios' | 'android', pushToken: string) {
  await db.execute(
    sql`INSERT INTO registered_devices (id, member_id, platform, push_token) VALUES (${randomUUID()}, ${memberId}, ${platform}, ${pushToken})`,
  );
}

describe('STR-133 T-U3 — publishing pushes to the board audience, deep-linking the post (covers TC-COM-003)', () => {
  it('given a project post; then exactly one push per targeted device deep-links /me/bulletin/{postId}, and a member outside the audience gets none', async () => {
    const db = await freshMigratedDb();
    const adapter = new FakePushAdapter();
    registerBulletinPushListener(db, adapter);

    const project = await createProject(db, { name: 'Green Meadows' });
    const owner = await activeMember(db, 'Asha Rao');
    await ownInProject(db, project.project_id, owner.member_id, 'A-101');
    const pc = await activeMember(db, 'Ravi Chair');
    await seatOnPc(db, project.project_id, [pc.member_id]);
    const outsider = await activeMember(db, 'Outsider Ojas');

    await registerDevice(db, owner.member_id, 'ios', 'owner-ios');
    await registerDevice(db, owner.member_id, 'android', 'owner-android');
    await registerDevice(db, pc.member_id, 'ios', 'pc-ios');
    await registerDevice(db, outsider.member_id, 'ios', 'outsider-ios');

    const post = await createBulletinPost(db, pc.member_id, {
      scope: 'project',
      project_id: project.project_id,
      title: 'Lift servicing',
      body: 'Lift down on Monday.',
    });

    expect(adapter.sent.map(send => send.pushToken).sort()).toEqual(['owner-android', 'owner-ios', 'pc-ios']);
    for (const send of adapter.sent) {
      expect(send.notification.deepLink).toBe(`/me/bulletin/${post.postId}`);
    }
  });

  it('given a society post; then every member with app access is pushed, and the pushed set is exactly resolveBulletinBoardAudience (AC3)', async () => {
    const db = await freshMigratedDb();
    const adapter = new FakePushAdapter();
    registerBulletinPushListener(db, adapter);

    const ec = await ecMember(db, 'Ec Author');
    const asha = await activeMember(db, 'Asha Rao');
    const priya = await activeMember(db, 'Priya Nair');
    // `pending` — admitted members only have app access (Communication:
    // "all members with app access").
    const pending = await createMember(db, { name: 'Pending Pia' });

    await registerDevice(db, ec.member_id, 'ios', 'ec-ios');
    await registerDevice(db, asha.member_id, 'ios', 'asha-ios');
    await registerDevice(db, priya.member_id, 'android', 'priya-android');
    await registerDevice(db, pending.member_id, 'ios', 'pending-ios');

    await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'AGM', body: 'Saturday.' });

    const audience = await resolveBulletinBoardAudience(db, 'society', null);
    expect([...audience].sort()).toEqual([asha.member_id, ec.member_id, priya.member_id].sort());
    expect(adapter.sent.map(send => send.pushToken).sort()).toEqual(['asha-ios', 'ec-ios', 'priya-android']);
  });
});

describe('STR-133 T-U4 — device-less members fail soft; suspended members keep app access', () => {
  it('given a targeted member with no registered device; then publishing sends nothing for them and does not throw', async () => {
    const db = await freshMigratedDb();
    const adapter = new FakePushAdapter();
    registerBulletinPushListener(db, adapter);

    const ec = await ecMember(db, 'Ec Author');
    const deviceless = await activeMember(db, 'Deviceless Deepa');

    const post = await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'AGM', body: 'Saturday.' });

    expect((await resolveBulletinBoardAudience(db, 'society', null))).toContain(deviceless.member_id);
    expect(adapter.sent).toEqual([]);
    expect(post.title).toBe('AGM');
  });

  it('given a suspended member; then they remain in the society-board audience and are pushed (app access is active/suspended)', async () => {
    const db = await freshMigratedDb();
    const adapter = new FakePushAdapter();
    registerBulletinPushListener(db, adapter);

    const ec = await ecMember(db, 'Ec Author');
    const suspended = await activeMember(db, 'Suspended Sam');
    await suspendMember(db, suspended.member_id, 'admin-1');
    await registerDevice(db, suspended.member_id, 'ios', 'suspended-ios');

    await createBulletinPost(db, ec.member_id, { scope: 'society', title: 'AGM', body: 'Saturday.' });

    expect(await resolveBulletinBoardAudience(db, 'society', null)).toContain(suspended.member_id);
    expect(adapter.sent.map(send => send.pushToken)).toContain('suspended-ios');
  });
});
