import { describe, it, expect } from 'vitest';

describe('branch-protection proof (scratch, not merged)', () => {
  it('deliberately fails to prove branch protection blocks merge', () => {
    expect(1).toBe(2);
  });
});
