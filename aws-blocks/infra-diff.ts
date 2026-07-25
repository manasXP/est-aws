export const STATEFUL_RESOURCE_TYPES = ['AWS::RDS::DBCluster', 'AWS::S3::Bucket'] as const;

// CFN resources of a stateful type that are explicitly disposable (removal
// policy DESTROY, e.g. the Blocks framework's own config bucket) emit
// DeletionPolicy: Delete, not Retain/Snapshot. Only Retain/Snapshot resources
// are the ones a Block-ID rename would actually destroy data by recreating —
// scoping to them keeps an unrelated disposable bucket of the same CFN type
// from tripping the gate.
const PROTECTED_DELETION_POLICIES = ['Retain', 'Snapshot'];

export interface CfnTemplate {
  Resources?: Record<string, { Type?: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }>;
}

export interface StatefulResourceViolation {
  logicalId: string;
  resourceType: string;
  changeType: 'deleted' | 'replaced';
}

/**
 * Release & Rollback pipeline gate 2: a stateful Block ID rename recreates
 * the resource, which is permanent data loss (estatly-db, estatly-documents).
 * Matching is by the (logical ID, resource type) pair CloudFormation itself
 * uses to identify a resource across deploys, not a name/string check — a
 * rename changes the CDK-derived logical ID, so the old identity simply
 * vanishes from the candidate template regardless of what the new resource
 * is called. Only catches identity changes at a stable logical ID (a Block-ID
 * rename); a property change that CFN would replace under an unchanged
 * logical ID is out of scope.
 */
export function diffStatefulResources(baseline: CfnTemplate, candidate: CfnTemplate): StatefulResourceViolation[] {
  const baselineResources = baseline.Resources ?? {};
  const candidateResources = candidate.Resources ?? {};
  const violations: StatefulResourceViolation[] = [];

  for (const [logicalId, resource] of Object.entries(baselineResources)) {
    const resourceType = resource.Type;
    if (!resourceType || !(STATEFUL_RESOURCE_TYPES as readonly string[]).includes(resourceType)) continue;
    if (!resource.DeletionPolicy || !PROTECTED_DELETION_POLICIES.includes(resource.DeletionPolicy)) continue;

    const survivor = candidateResources[logicalId];
    if (survivor && survivor.Type === resourceType) continue;

    const stillHasType = Object.values(candidateResources).some(r => r.Type === resourceType);
    violations.push({ logicalId, resourceType, changeType: stillHasType ? 'replaced' : 'deleted' });
  }

  return violations;
}
