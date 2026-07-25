import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

// STR-004 Q1: does an IFC app declaring every mapped Block synthesize (and,
// separately, deploy — proven live outside this test, see the PR/architecture
// doc for the real ap-south-1 proof run) without CDK-level errors?
// This is the local, AWS-free half only — synth needs no credentials and
// catches wiring/prop mistakes before ever touching real AWS. Throwaway with
// the rest of the Q1 spike scope once the real deploy evidence is captured
// (no future story consumes the full bundled set as-is — Blocks join the
// real app individually, per their own consuming story).
describe('STR-004 Q1 — full mapped Block set (local synth check)', () => {
  it('synthesizes every mapped Block together with no CDK errors', () => {
    const yaml = execFileSync(
      'npx',
      ['cdk', 'synth', '--app', 'npx tsx -C cdk test/spikes/str004-full-block-set.cdk.ts', 'str004-spike-fullblockset'],
      { encoding: 'utf-8', timeout: 60_000 },
    );

    // One resource per stateful/observable Block, proving each actually
    // wired into the template (not just that the process exited 0).
    expect(yaml).toContain('AWS::RDS::DBCluster');       // Database
    expect(yaml).toContain('AWS::S3::Bucket');            // FileBucket
    expect(yaml).toContain('AWS::Cognito::UserPool');     // AuthCognito
    expect(yaml).toContain('AWS::Scheduler::Schedule');   // CronJob
    expect(yaml).toContain('AWS::SQS::Queue');            // AsyncJob
    expect(yaml).toContain('AWS::SSM::Parameter');        // AppSetting
    expect(yaml).toContain('AWS::CloudWatch::Dashboard'); // Dashboard
    expect(yaml).toContain('ses:SendEmail');              // EmailClient (IAM permission, no dedicated resource)
  });
});
