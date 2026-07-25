import { describe, it, expect } from 'vitest';

describe('CI-blocking proof (scratch, not merged)', () => {
  it('deliberately fails to prove CI goes red', () => {
    expect(1).toBe(2);
  });
});
