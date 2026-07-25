export const STATEFUL_RESOURCE_TYPES = ['AWS::RDS::DBCluster', 'AWS::S3::Bucket'] as const;

export interface CfnTemplate {
  Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
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
 * is called.
 */
export function diffStatefulResources(baseline: CfnTemplate, candidate: CfnTemplate): StatefulResourceViolation[] {
  const baselineResources = baseline.Resources ?? {};
  const candidateResources = candidate.Resources ?? {};
  const violations: StatefulResourceViolation[] = [];

  for (const [logicalId, resource] of Object.entries(baselineResources)) {
    const resourceType = resource.Type;
    if (!resourceType || !(STATEFUL_RESOURCE_TYPES as readonly string[]).includes(resourceType)) continue;

    const survivor = candidateResources[logicalId];
    if (survivor && survivor.Type === resourceType) continue;

    const stillHasType = Object.values(candidateResources).some(r => r.Type === resourceType);
    violations.push({ logicalId, resourceType, changeType: stillHasType ? 'replaced' : 'deleted' });
  }

  return violations;
}
