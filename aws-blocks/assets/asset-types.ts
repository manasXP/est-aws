// STR-051 Refactor: the asset type/status enums, extracted out of
// assets-api.ts for reuse by STR-053 (allotment, which needs AssetStatus to
// set `allotted`) and E07 (charge basis, which needs AssetType).
export type AssetType = 'flat' | 'plot' | 'villa' | 'dividend';
export type AssetStatus = 'allotted' | 'available' | 'society_retained';

export const ASSET_TYPES: AssetType[] = ['flat', 'plot', 'villa', 'dividend'];

// `allotted` is only ever set by ownership assignment (STR-053) -- never
// accepted directly through create or edit.
export const WRITABLE_STATUSES: AssetStatus[] = ['available', 'society_retained'];
