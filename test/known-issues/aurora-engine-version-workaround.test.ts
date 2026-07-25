import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnDBCluster } from 'aws-cdk-lib/aws-rds';
import { overrideDeprecatedAuroraEngineVersion } from '../../aws-blocks/known-issues/aurora-engine-version-workaround';

// STR-004: proves the escape hatch documented in the architecture doc for
// STR-011/STR-014 to reuse actually works, and fails loudly rather than
// silently no-op'ing — local, AWS-free (pure CDK synth, no deploy).
describe('overrideDeprecatedAuroraEngineVersion', () => {
  it('overrides EngineVersion on every CfnDBCluster under the given scope', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Test');
    new CfnDBCluster(stack, 'Cluster', { engine: 'aurora-postgresql', engineVersion: '16.4' });

    overrideDeprecatedAuroraEngineVersion(stack, '16.13');

    Template.fromStack(stack).hasResourceProperties('AWS::RDS::DBCluster', {
      EngineVersion: '16.13',
    });
  });

  it('throws rather than silently doing nothing when no cluster exists', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Empty');

    expect(() => overrideDeprecatedAuroraEngineVersion(stack)).toThrow(/no CfnDBCluster found/);
  });
});
