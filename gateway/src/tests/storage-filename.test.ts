/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Parse answers "Filename contains invalid characters" for anything outside a
 * narrow ASCII set, and a legal system in Israel names its documents in Hebrew.
 * The failure surfaced as "uploadFile failed" with nothing about filenames in
 * it, so these cases are pinned.
 */

import { describe, it, expect } from 'vitest';
import { storageSafeFilename } from '../opensign/opensign-client.js';

/** What Parse itself will accept. */
const PARSE_SAFE = /^[_a-zA-Z0-9][a-zA-Z0-9@. ~_-]*$/;

describe('storageSafeFilename', () => {
  it('leaves an already-safe name alone', () => {
    expect(storageSafeFilename('engagement-letter.pdf')).toBe('engagement-letter.pdf');
  });

  it('accepts a Hebrew filename, which has no usable characters at all', () => {
    const result = storageSafeFilename('כתב תביעה מתוקן.pdf');
    expect(result).toMatch(PARSE_SAFE);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('keeps the letters of an accented Latin name rather than discarding it', () => {
    // NFKD splits é into e + combining mark, so the letter survives.
    expect(storageSafeFilename('Réglement Intérieur.pdf')).toBe('Reglement-Interieur.pdf');
  });

  it('does not leave a name starting with a character Parse rejects', () => {
    // Parse requires the first character to be alphanumeric or underscore.
    expect(storageSafeFilename('—draft.pdf')).toMatch(/^[_A-Za-z0-9]/);
  });

  it('supplies an extension when the original has none', () => {
    expect(storageSafeFilename('scan')).toBe('scan.pdf');
  });

  it('keeps a non-pdf extension', () => {
    expect(storageSafeFilename('contract.docx')).toBe('contract.docx');
  });

  it('does not treat a leading dot as an extension', () => {
    const result = storageSafeFilename('.hidden');
    expect(result).toMatch(PARSE_SAFE);
  });

  it('bounds the length', () => {
    const result = storageSafeFilename(`${'a'.repeat(400)}.pdf`);
    expect(result.length).toBeLessThanOrEqual(90);
  });

  it('collapses runs of separators instead of emitting a row of dashes', () => {
    expect(storageSafeFilename('a  ///  b.pdf')).toBe('a-b.pdf');
  });

  it('produces something Parse accepts for every case here', () => {
    for (const name of [
      'כתב תביעה.pdf',
      '合同.pdf',
      'عقد.pdf',
      '???.pdf',
      '.pdf',
      '',
      '   ',
      '../../etc/passwd',
    ]) {
      expect(storageSafeFilename(name)).toMatch(PARSE_SAFE);
    }
  });

  it('does not carry path separators through', () => {
    // Not a traversal defence — that is Parse's job — but a filename with a
    // slash in it is not a filename.
    expect(storageSafeFilename('../../etc/passwd')).not.toContain('/');
  });
});
