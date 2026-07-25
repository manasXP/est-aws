import { describe, it, expect } from 'vitest';
import { instantiateMappedBlocks } from './block-signatures';

// STR-003 Q2: do the real SDK signatures of every mapped Block (per the
// Estatly architecture doc's block-set table) match the documented notes in
// .claude/skills/aws-blocks/reference.md? Database and FileBucket are already
// proven by STR-001 (aws-blocks/index.ts) — this spike covers the remaining
// eight. Proof: the instantiation compiles under TypeScript strict
// (`npm test` runs `tsc --noEmit`) and every instance is usable at runtime.

describe('STR-003 Q2 — mapped Block SDK signatures', () => {
  it('every remaining mapped Block instantiates from its documented constructor shape', () => {
    const blocks = instantiateMappedBlocks();
    for (const [name, block] of Object.entries(blocks)) {
      expect(block, `${name} should instantiate`).toBeDefined();
      expect(block.fullId, `${name}.fullId should be a non-empty string`).toMatch(/.+/);
    }
  });
});
