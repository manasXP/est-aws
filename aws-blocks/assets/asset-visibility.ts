// STR-057: the role-scoped asset-visibility query layer (Asset Management
// spec's visibility matrix) -- every asset-bearing read this story adds
// goes through here rather than querying assets/ownerships directly (DoD).
// The EC all-projects view needs no new code: it's the existing
// `listAssets(db)` with no project_id filter (STR-051), already admin-only
// since no mobile route exposes it (AC3, test/assets/asset-visibility.test.ts
// T-U1's structural checks).
import type { Database } from '@aws-blocks/blocks';
import { getAsset, listAssets, type Asset, type AssetType, type AssetStatus } from './assets-api';
import { listOwnershipsForMember, getOwnership } from './ownerships-api';
import { getProject } from '../projects/projects-api';
import { getProjectCommittee } from '../projects/committees-api';
import { getMember } from '../members/members-api';
import { getAssetViewGrants } from '../employees/asset-view-grants-api';

/** The mobile OpenAPI's Asset shape -- a strict subset of the Admin Asset
 * (components/schemas/Asset), with no project_id/current_ownership_id. */
export interface MobileAsset {
  asset_id: string;
  type: AssetType;
  label?: string;
  attributes?: Record<string, unknown>;
  status: AssetStatus;
}

function toMobileAsset(asset: Asset): MobileAsset {
  const mobileAsset: MobileAsset = { asset_id: asset.asset_id, type: asset.type, status: asset.status };
  if (asset.label !== undefined) mobileAsset.label = asset.label;
  if (asset.attributes !== undefined) mobileAsset.attributes = asset.attributes;
  return mobileAsset;
}

/** The mobile OpenAPI's Ownership shape (components/schemas/Ownership). */
export interface MemberOwnershipView {
  ownership_id: string;
  project_id: string;
  project_name: string;
  asset: MobileAsset;
}

/**
 * `GET /me/ownerships` (T-C1, covers TC-AST-040, AC1) -- every ownership of
 * `memberId`, each embedding its asset's mobile detail. The member-scoping
 * boundary is entirely `listOwnershipsForMember`'s `WHERE member_id = ...`
 * -- there is no code path here that could return another member's row.
 */
export async function listMemberOwnershipsWithAssets(db: Database, memberId: string): Promise<MemberOwnershipView[]> {
  const ownerships = await listOwnershipsForMember(db, memberId);
  const views: MemberOwnershipView[] = [];
  for (const ownership of ownerships) {
    const [asset, project] = await Promise.all([getAsset(db, ownership.asset_id), getProject(db, ownership.project_id)]);
    views.push({
      ownership_id: ownership.ownership_id,
      project_id: ownership.project_id,
      project_name: project!.name,
      asset: toMobileAsset(asset!),
    });
  }
  return views;
}

/** The mobile OpenAPI's PcAsset shape (components/schemas/PcAsset). */
export interface PcAssetView extends MobileAsset {
  current_owner: { member_id: string; name: string } | null;
}

/** Shared per-project scope check (Refactor): true if `projectId` is among
 * the ids the caller is scoped to -- the PC read passes committee seats,
 * the employee-grant read passes granted project ids. */
function isProjectInScope(scopedProjectIds: readonly string[], projectId: string): boolean {
  return scopedProjectIds.includes(projectId);
}

/** `GET /pc/projects/{projectId}/assets`'s 403 gate (T-C2, covers
 * TC-AST-041) -- true if `memberId` currently sits on `projectId`'s PC. */
export async function isPcMember(db: Database, projectId: string, memberId: string): Promise<boolean> {
  const committee = await getProjectCommittee(db, projectId);
  if (!committee) return false;
  return isProjectInScope(committee.member_ids, memberId);
}

/**
 * `GET /pc/projects/{projectId}/assets` (T-C2, covers TC-AST-041, AC2) --
 * the project's full registry, including unowned assets, with current-owner
 * identity. Assumes the caller has already been authorized as a PC member
 * (isPcMember) -- this function itself does no scoping.
 */
export async function listPcProjectAssets(db: Database, projectId: string): Promise<PcAssetView[]> {
  const assets = await listAssets(db, { projectId });
  const views: PcAssetView[] = [];
  for (const asset of assets) {
    let currentOwner: { member_id: string; name: string } | null = null;
    if (asset.current_ownership_id) {
      const ownership = await getOwnership(db, asset.current_ownership_id);
      const member = ownership ? await getMember(db, ownership.member_id) : null;
      if (member) currentOwner = { member_id: member.member_id, name: member.name };
    }
    views.push({ ...toMobileAsset(asset), current_owner: currentOwner });
  }
  return views;
}

/** `hasAssetViewGrant`'s underlying scope check (T-U2, covers TC-AST-043)
 * -- true if `employeeId` currently holds a grant for `projectId`. */
export async function hasAssetViewGrant(db: Database, employeeId: string, projectId: string): Promise<boolean> {
  const grantedProjectIds = await getAssetViewGrants(db, employeeId);
  return isProjectInScope(grantedProjectIds, projectId);
}

/**
 * The granted-employee read (T-U2, covers TC-AST-043, AC2) -- `projectId`'s
 * assets if `employeeId` holds a grant for it, otherwise none. Reuses the
 * same `listAssets(db, {projectId})` call the PC read does -- the two
 * project-scoped reads differ only in their authorization predicate, not in
 * how they fetch the registry.
 */
export async function listAssetsVisibleToEmployee(db: Database, employeeId: string, projectId: string): Promise<Asset[]> {
  if (!(await hasAssetViewGrant(db, employeeId, projectId))) return [];
  return listAssets(db, { projectId });
}
