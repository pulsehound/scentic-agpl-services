/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The conversion between Scentic's fractional coordinates and OpenSign's
 * absolute ones. A mistake here does not fail — it puts a signature block in
 * the wrong place on a legal document, which is worse than an error.
 */

import { describe, it, expect } from 'vitest';
import { placeholdersForSigner, buildPlaceholders, placeholderId } from '../opensign/placeholders.js';

const field = (over: Partial<Parameters<typeof placeholdersForSigner>[0][0]> = {}) => ({
  pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05,
  type: 'signature', required: true, ...over,
});

describe('placeholdersForSigner', () => {
  it('converts fractions to the reference page size', () => {
    const [page] = placeholdersForSigner([field({ x: 0.5, y: 0.5, width: 0.2, height: 0.1 })]);
    const widget = page.pos[0] as Record<string, number>;
    expect(widget.xPosition).toBeCloseTo(297.5);   // 0.5 * 595
    expect(widget.yPosition).toBeCloseTo(421);     // 0.5 * 842
    expect(widget.Width).toBeCloseTo(119);         // 0.2 * 595
    expect(widget.Height).toBeCloseTo(84.2);       // 0.1 * 842
  });

  it('records scale 1, because the values need no further undoing', () => {
    // OpenSign's editor stores Width divided by the scale it was placed at.
    // These are already in reference units, so anything else double-scales them.
    const [page] = placeholdersForSigner([field()]);
    expect((page.pos[0] as Record<string, number>).scale).toBe(1);
  });

  it('groups widgets by page', () => {
    const pages = placeholdersForSigner([
      field({ pageNumber: 1 }), field({ pageNumber: 3 }), field({ pageNumber: 1 }),
    ]);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 3]);
    expect(pages[0].pos).toHaveLength(2);
    expect(pages[1].pos).toHaveLength(1);
  });

  it('orders pages ascending, not by the order fields were drawn', () => {
    const pages = placeholdersForSigner([field({ pageNumber: 7 }), field({ pageNumber: 2 })]);
    expect(pages.map((p) => p.pageNumber)).toEqual([2, 7]);
  });

  it('marks a stamp as one and nothing else', () => {
    const stamp = placeholdersForSigner([field({ type: 'stamp' })])[0].pos[0] as Record<string, unknown>;
    const sig = placeholdersForSigner([field({ type: 'signature' })])[0].pos[0] as Record<string, unknown>;
    expect(stamp.isStamp).toBe(true);
    expect(sig.isStamp).toBe(false);
  });

  it('falls back to something the signer types for a type OpenSign does not know', () => {
    // OpenSign's "text" is a fixed label the signer cannot fill; "text input" is what they type.
    const widget = placeholdersForSigner([field({ type: 'nonsense' })])[0].pos[0] as Record<string, unknown>;
    expect(widget.type).toBe('text input');
  });

  it("maps Scentic's TEXT and RADIO to OpenSign's signer-filled widgets", () => {
    const [text, radio] = placeholdersForSigner([field({ type: 'TEXT' }), field({ type: 'RADIO' })])[0].pos as Array<Record<string, unknown>>;
    expect(text.type).toBe('text input');
    expect(radio.type).toBe('radio button');
  });

  it('makes a date the date of signing, which the signer cannot change', () => {
    // "today" is OpenSign's own value: it stamps the day the signer finishes, in the format given.
    const widget = placeholdersForSigner([field({ type: 'DATE' })], Math.random, 'dd/MM/yyyy')[0].pos[0] as { options: Record<string, unknown> };
    expect(widget.options).toMatchObject({
      response: 'today',
      isReadOnly: true,
      validation: { format: 'dd/MM/yyyy', type: 'date-format' },
    });
  });

  it('titles fields readably, numbering repeats of the same kind', () => {
    const names = placeholdersForSigner([field(), field({ type: 'DATE' }), field(), field({ label: 'Witness' })])[0]
      .pos.map((w) => (w as { options: { name: string } }).options.name);
    expect(names).toEqual(['Signature', 'Date signed', 'Signature 2', 'Witness']);
  });

  it('gives an email its validation, as the editor does', () => {
    const widget = placeholdersForSigner([field({ type: 'EMAIL' })])[0].pos[0] as { options: Record<string, unknown> };
    expect(widget.options).toMatchObject({ defaultValue: '', validation: { type: 'email', pattern: '' } });
  });

  it('gives every widget a distinct key and name', () => {
    let n = 0;
    const random = () => ((n += 1) * 0.1) % 1;
    const widgets = placeholdersForSigner(
      [field(), field({ type: 'date' }), field(), field({ pageNumber: 2 })],
      random,
    ).flatMap((page) => page.pos) as Array<{ key: number; options: { name: string } }>;
    expect(new Set(widgets.map((w) => w.key)).size).toBe(widgets.length);
    expect(new Set(widgets.map((w) => w.options.name)).size).toBe(widgets.length);
  });

  it('accepts the enum spelling Scentic stores', () => {
    // JOB_TITLE in the database, "job title" in OpenSign.
    const widget = placeholdersForSigner([field({ type: 'JOB_TITLE' })])[0].pos[0] as Record<string, unknown>;
    expect(widget.type).toBe('job title');
  });

  it('carries required through to the status OpenSign reads', () => {
    const required = placeholdersForSigner([field({ required: true })])[0].pos[0] as { options: Record<string, string> };
    const optional = placeholdersForSigner([field({ required: false })])[0].pos[0] as { options: Record<string, string> };
    expect(required.options.status).toBe('required');
    expect(optional.options.status).toBe('optional');
  });

  it('clamps a page number below one rather than emitting page zero', () => {
    expect(placeholdersForSigner([field({ pageNumber: 0 })])[0].pageNumber).toBe(1);
  });
});

describe('buildPlaceholders', () => {
  const signers = [
    { email: 'First@Example.com', role: 'signer' },
    { email: 'second@example.com', role: 'approver' },
  ];

  it('gives each signer only their own fields, matching on email case-insensitively', () => {
    const built = buildPlaceholders(signers, [
      field({ signerEmail: 'first@example.com' }),
      field({ signerEmail: 'SECOND@example.com', pageNumber: 2 }),
      field({ signerEmail: 'first@example.com', pageNumber: 4 }),
    ]);
    expect(built[0].placeHolder as unknown[]).toHaveLength(2);
    expect(built[1].placeHolder as unknown[]).toHaveLength(1);
  });

  it('lowercases the placeholder email, which is what linking compares against', () => {
    expect(buildPlaceholders(signers, [])[0].email).toBe('first@example.com');
  });

  it('leaves a signer with no fields an empty list rather than omitting them', () => {
    // An empty placeHolder means "place your own signature" — the behaviour
    // every document had before placements existed. Dropping the signer
    // entirely would remove them from the document.
    const built = buildPlaceholders(signers, [field({ signerEmail: 'first@example.com' })]);
    expect(built).toHaveLength(2);
    expect(built[1].placeHolder).toEqual([]);
  });

  it('gives each signer the Id and colour OpenSign\'s signing page looks them up by', () => {
    // Without an Id the signing page crashed for every signer: it finds the signer's placeholder
    // with placeholders.filter((p) => p.Id === uniqueId)[0].
    const built = buildPlaceholders(signers, [field({ signerEmail: 'first@example.com' })]);
    for (const signer of built) {
      expect(signer.Id).toEqual(expect.any(Number));
      expect(String(signer.Id)).toMatch(/^\d{8}$/);
      expect(signer.blockColor).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(built[0].blockColor).not.toBe(built[1].blockColor);
  });

  it('ignores a field addressed to nobody on the document', () => {
    const built = buildPlaceholders(signers, [field({ signerEmail: 'stranger@example.com' })]);
    expect(built.every((p) => (p.placeHolder as unknown[]).length === 0)).toBe(true);
  });
});

describe('placeholderId', () => {
  it('is always eight digits, as the editor makes them', () => {
    expect(placeholderId(() => 0)).toBe(10_000_000);
    expect(String(placeholderId(() => 0.999999999))).toMatch(/^\d{8}$/);
  });
});
