import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffStatefulResources, STATEFUL_RESOURCE_TYPES, type CfnTemplate } from '../aws-blocks/infra-diff';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_BASELINE: CfnTemplate = JSON.parse(
  readFileSync(join(__dirname, '../aws-blocks/infra-baseline.json'), 'utf-8'),
);

// STR-013 — automated infra-diff gate (T-U1..T-U3: no TC case covers this
// repo-tooling behavior, so all three are genuine-gap IDs per the story).
// The analyzer takes two already-synthesized CloudFormation templates and
// flags any stateful resource (Aurora cluster, document S3 bucket) that
// doesn't survive at the same (logical ID, type) pair from baseline to
// candidate — the exact shape a Block-ID rename produces.

function template(resources: Record<string, { Type: string }>) {
  return { Resources: resources };
}

describe('STR-013 infra-diff — stateful resource protection', () => {
  // T-U1
  it('flags the Aurora cluster whether it is deleted outright or replaced under a new logical ID', () => {
    const baseline = template({
      DbCluster1234: { Type: 'AWS::RDS::DBCluster' },
    });

    const deleted = diffStatefulResources(baseline, template({}));
    expect(deleted).toEqual([
      { logicalId: 'DbCluster1234', resourceType: 'AWS::RDS::DBCluster', changeType: 'deleted' },
    ]);

    const renamed = diffStatefulResources(
      baseline,
      template({ DbClusterRenamed5678: { Type: 'AWS::RDS::DBCluster' } }),
    );
    expect(renamed).toEqual([
      { logicalId: 'DbCluster1234', resourceType: 'AWS::RDS::DBCluster', changeType: 'replaced' },
    ]);
  });

  // T-U2
  it('flags the document bucket the same way', () => {
    const baseline = template({
      DocumentsBucketABCD: { Type: 'AWS::S3::Bucket' },
    });

    const deleted = diffStatefulResources(baseline, template({}));
    expect(deleted).toEqual([
      { logicalId: 'DocumentsBucketABCD', resourceType: 'AWS::S3::Bucket', changeType: 'deleted' },
    ]);

    const renamed = diffStatefulResources(
      baseline,
      template({ DocumentsBucketWXYZ: { Type: 'AWS::S3::Bucket' } }),
    );
    expect(renamed).toEqual([
      { logicalId: 'DocumentsBucketABCD', resourceType: 'AWS::S3::Bucket', changeType: 'replaced' },
    ]);
  });

  // T-U3
  it('passes an additive-only diff — new resources of any type, stateful or not', () => {
    const baseline = template({
      DbCluster1234: { Type: 'AWS::RDS::DBCluster' },
      DocumentsBucketABCD: { Type: 'AWS::S3::Bucket' },
    });

    const candidate = template({
      DbCluster1234: { Type: 'AWS::RDS::DBCluster' },
      DocumentsBucketABCD: { Type: 'AWS::S3::Bucket' },
      NewFn5678: { Type: 'AWS::Lambda::Function' },
      NewQueue9ABC: { Type: 'AWS::SQS::Queue' },
      NewTableDEF0: { Type: 'AWS::DynamoDB::Table' },
      NewBucket1111: { Type: 'AWS::S3::Bucket' },
    });

    expect(diffStatefulResources(baseline, candidate)).toEqual([]);
  });

  // Refactor (AC2) — permanent Block-ID rename self-test, grounded in the
  // real committed baseline rather than synthetic IDs: proves the gate would
  // catch the actual estatly-db / estatly-documents rename this story exists
  // to prevent, and stays accurate automatically whenever the baseline (and
  // therefore the real logical IDs) is refreshed.
  it('blocks a rename of every real stateful resource in the committed baseline', () => {
    const realStatefulResources = Object.entries(REAL_BASELINE.Resources ?? {}).filter(
      ([, r]) => r.Type && (STATEFUL_RESOURCE_TYPES as readonly string[]).includes(r.Type),
    );
    expect(realStatefulResources.length).toBeGreaterThan(0);

    for (const [logicalId] of realStatefulResources) {
      const { [logicalId]: _removed, ...remaining } = REAL_BASELINE.Resources!;
      const renamedCandidate: CfnTemplate = { Resources: remaining };

      const violations = diffStatefulResources(REAL_BASELINE, renamedCandidate);
      expect(violations.some(v => v.logicalId === logicalId)).toBe(true);
    }
  });
});
