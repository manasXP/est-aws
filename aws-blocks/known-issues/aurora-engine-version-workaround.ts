import { CfnDBCluster } from 'aws-cdk-lib/aws-rds';
import type { IConstruct } from 'constructs';

/**
 * @aws-blocks/bb-data@0.2.2 hardcodes Aurora PostgreSQL engine version 16.4
 * (infra.ts, AuroraPostgresEngineVersion.VER_16_4) with no DatabaseOptions
 * field to override it. AWS has removed 16.4 everywhere — confirmed absent
 * in ap-south-1, us-east-1, and eu-west-1 via `aws rds describe-db-engine-versions`
 * (STR-004); no newer @aws-blocks/bb-data version exists to fix it as of
 * 2026-07-25. Any real Database deploy CREATE_FAILEDs on this until patched.
 *
 * Call once per stack, after every Database Block has been constructed,
 * before synth/deploy. Throws rather than silently no-op'ing if it finds
 * nothing to patch, and patches every matching cluster, not just the first —
 * a future stack with more than one Database Block should not have any
 * cluster silently left on the deprecated version.
 */
export function overrideDeprecatedAuroraEngineVersion(stackRoot: IConstruct, version = '16.13'): void {
  const clusters = stackRoot.node.findAll().filter((c): c is CfnDBCluster => c instanceof CfnDBCluster);
  if (clusters.length === 0) {
    throw new Error('overrideDeprecatedAuroraEngineVersion: no CfnDBCluster found under the given scope — nothing to patch');
  }
  for (const cluster of clusters) {
    cluster.addPropertyOverride('EngineVersion', version);
  }
}
