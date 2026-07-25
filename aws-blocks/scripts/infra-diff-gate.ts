#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { blocksStack } from '../index.cdk';
import { diffStatefulResources, type CfnTemplate } from '../infra-diff';

// Baseline handling (M0, pre-first-tag): the baseline is the main-branch
// synthesized template, stored as this committed file. Once releases exist,
// switch this to the previous tag's template per Release & Rollback. Refresh
// it with `npm run infra-diff:update-baseline` — legitimate stateful changes
// (e.g. a deliberately decommissioned resource) are the only reason to.
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra-baseline.json');

const candidate = Template.fromStack(blocksStack).toJSON() as CfnTemplate;

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify(candidate, null, 2) + '\n');
  console.log(`[infra-diff] baseline written: ${BASELINE_PATH}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`[infra-diff] no baseline at ${BASELINE_PATH} — run "npm run infra-diff:update-baseline" once to create it.`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as CfnTemplate;

// Fail closed: a baseline with no resources (corrupt file, botched merge,
// truncated write) would otherwise diff clean against anything and silently
// disable the gate instead of blocking.
if (Object.keys(baseline.Resources ?? {}).length === 0) {
  console.error(`[infra-diff] baseline at ${BASELINE_PATH} has no Resources — treating as corrupt, not as "nothing to protect".`);
  process.exit(1);
}

const violations = diffStatefulResources(baseline, candidate);

if (violations.length > 0) {
  console.error('[infra-diff] BLOCKED — stateful resource deletion/replacement detected:');
  for (const v of violations) {
    console.error(`  ${v.changeType} ${v.resourceType} ${v.logicalId}`);
  }
  process.exit(1);
}

console.log('[infra-diff] passed — no stateful resource deletion or replacement.');
