/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A signer without a role made createWorkflow call s.role.toLowerCase() on
 * undefined. The resulting TypeError left the caller with "An internal error
 * occurred" and no way to tell a malformed payload from a broken gateway.
 */

import { describe, it, expect } from 'vitest';
import { normaliseSigners } from '../routes/signature.js';

describe('normaliseSigners', () => {
  it('defaults the role that used to throw', () => {
    const [signer] = normaliseSigners([{ email: 'a@example.com', name: 'A', order: 1 }]);
    expect(signer.role).toBe('signer');
  });

  it('keeps a role that was supplied', () => {
    const [signer] = normaliseSigners([{ email: 'a@example.com', role: 'approver' }]);
    expect(signer.role).toBe('approver');
  });

  it('identifies a counterparty by address when they have no Scentic id', () => {
    const [signer] = normaliseSigners([{ email: 'counterparty@example.com' }]);
    expect(signer.scenticSignerId).toBe('counterparty@example.com');
  });

  it('prefers a real Scentic id where one exists', () => {
    const [signer] = normaliseSigners([{ email: 'a@example.com', scenticSignerId: 'usr_1' }]);
    expect(signer.scenticSignerId).toBe('usr_1');
  });

  it('falls back to the address for a missing name', () => {
    const [signer] = normaliseSigners([{ email: 'a@example.com' }]);
    expect(signer.name).toBe('a@example.com');
  });

  it('numbers signers by position when order is absent', () => {
    const signers = normaliseSigners([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
    expect(signers.map((s) => s.order)).toEqual([1, 2]);
  });

  it('survives entries that are not objects at all', () => {
    // Nothing stops a caller sending these, and the answer must not be a 500.
    expect(() => normaliseSigners([null, undefined, 'nonsense', 42])).not.toThrow();
    expect(normaliseSigners([null]).length).toBe(1);
  });

  it('returns empty for a missing or non-array payload', () => {
    expect(normaliseSigners(undefined)).toEqual([]);
    expect(normaliseSigners({})).toEqual([]);
  });

  it('gives every signer the fields createWorkflow reads', () => {
    for (const signer of normaliseSigners([{ email: 'a@x.com' }, null])) {
      expect(typeof signer.role).toBe('string');
      expect(typeof signer.scenticSignerId).toBe('string');
      expect(typeof signer.name).toBe('string');
      expect(typeof signer.order).toBe('number');
    }
  });
});
