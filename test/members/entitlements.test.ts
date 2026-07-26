import { describe, it, expect } from 'vitest';
import { canAccrueCharges, hasAppAccess, isRoleEligible, isDefaulter } from '../../aws-blocks/members/entitlements';
import type { MemberStatus } from '../../aws-blocks/members/members-api';

// STR-034 — status entitlement predicates and derived defaulter standing,
// unit + property cases. Pure functions, no DB, no HTTP surface (confirmed
// against both OpenAPI specs before writing this story).

describe('STR-034 T-U1 — a pending member (covers TC-MEM-002)', () => {
  it('cannot accrue charges, has no app access, and is not role-eligible', () => {
    expect(canAccrueCharges('pending')).toBe(false);
    expect(hasAppAccess('pending')).toBe(false);
    expect(isRoleEligible('pending')).toBe(false);
  });
});

describe('STR-034 T-U2 — a suspended member (covers TC-MEM-004)', () => {
  it('can log in and pay, charges continue to accrue, but is not role-eligible', () => {
    expect(hasAppAccess('suspended')).toBe(true);
    expect(canAccrueCharges('suspended')).toBe(true);
    expect(isRoleEligible('suspended')).toBe(false);
  });
});

describe('STR-034 T-U3 — defaulter standing is derived at read time, not stored, no automatic restriction (covers TC-MEM-010)', () => {
  it('reports a member with an overdue charge as a defaulter', () => {
    const overdue = isDefaulter('member-1', [{ memberId: 'member-1', dueDate: '2026-06-01' }], '2026-07-26');
    expect(overdue).toBe(true);
  });

  it('does not report a member with no outstanding charges as a defaulter', () => {
    const clean = isDefaulter('member-1', [], '2026-07-26');
    expect(clean).toBe(false);
  });

  it('does not report a member whose charge is not yet due as a defaulter', () => {
    const notYetDue = isDefaulter('member-1', [{ memberId: 'member-1', dueDate: '2026-08-01' }], '2026-07-26');
    expect(notYetDue).toBe(false);
  });

  it('ignores another member\'s overdue charges', () => {
    const otherMembersDebt = isDefaulter('member-1', [{ memberId: 'member-2', dueDate: '2026-06-01' }], '2026-07-26');
    expect(otherMembersDebt).toBe(false);
  });

  it('a charge due exactly today is not yet overdue (strict less-than)', () => {
    const dueToday = isDefaulter('member-1', [{ memberId: 'member-1', dueDate: '2026-07-26' }], '2026-07-26');
    expect(dueToday).toBe(false);
  });

  it('defaulter standing never gates app access or payment access — a suspended defaulter still has app access', () => {
    const status: MemberStatus = 'suspended';
    const defaulter = isDefaulter('member-1', [{ memberId: 'member-1', dueDate: '2026-06-01' }], '2026-07-26');
    expect(defaulter).toBe(true);
    // hasAppAccess is computed purely from status -- no coupling to
    // isDefaulter exists anywhere in this module (AC3: payment access is
    // never blocked by defaulter standing).
    expect(hasAppAccess(status)).toBe(true);
  });
});

describe('STR-034 T-P1 — role eligibility, charge-accrual eligibility, and app access hold exactly per status, for all four statuses', () => {
  const statuses: MemberStatus[] = ['pending', 'active', 'suspended', 'ceased'];

  for (const status of statuses) {
    it(`isRoleEligible('${status}') is ${status === 'active'} (iff status = active)`, () => {
      expect(isRoleEligible(status)).toBe(status === 'active');
    });

    it(`canAccrueCharges('${status}') is ${status === 'active' || status === 'suspended'} (iff status in {active, suspended})`, () => {
      expect(canAccrueCharges(status)).toBe(status === 'active' || status === 'suspended');
    });

    it(`hasAppAccess('${status}') is ${status === 'active' || status === 'suspended'} (iff status in {active, suspended})`, () => {
      expect(hasAppAccess(status)).toBe(status === 'active' || status === 'suspended');
    });
  }
});
