/**
 * Turning Scentic's field placements into OpenSign placeholders.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Two coordinate systems meet here and neither is negotiable.
 *
 * Scentic sends fractions of the page — 0..1, origin top-left. It has to: the
 * page is placed in a browser at whatever width the window allows, and the same
 * page in the PDF has its own size in points. A field recorded in screen pixels
 * is in the wrong place on paper, and in a different wrong place on every
 * screen.
 *
 * OpenSign stores absolute positions against a reference page width, grouped by
 * page, with each widget's size divided by the scale it was placed at. Its
 * editor writes `Width: rendered / (scale * ratio)`, so the values on record are
 * already normalised and the scale is carried alongside to undo it.
 *
 * The conversion below therefore multiplies by a fixed reference width rather
 * than by whatever the sender's window happened to be, and records scale 1 —
 * meaning "these numbers need no further undoing".
 */

/** Fractions of one page, as Scentic records them. */
export interface FieldPlacement {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  signerEmail?: string;
  required: boolean;
  label?: string;
  options?: Record<string, unknown>;
}

/**
 * The page size the positions are expressed against.
 *
 * A4 at 72dpi, which is what OpenSign's viewer uses as its reference. Any fixed
 * number works provided both sides agree; what must not happen is deriving it
 * from the sender's viewport, which differs per person and per zoom level.
 */
const REFERENCE_PAGE_WIDTH = 595;
const REFERENCE_PAGE_HEIGHT = 842;

/** OpenSign's own vocabulary. Anything unrecognised is treated as free text. */
const WIDGET_TYPES = new Set([
  'signature',
  'initials',
  'stamp',
  'date',
  'name',
  'email',
  'job title',
  'company',
  'text',
  'checkbox',
  'radio',
  'dropdown',
]);

function widgetType(type: string): string {
  const normalised = type.trim().toLowerCase().replace(/_/g, ' ');
  return WIDGET_TYPES.has(normalised) ? normalised : 'text';
}

/**
 * Build the `placeHolder` array for one signer.
 *
 * Grouped by page because that is how OpenSign stores it: one entry per page
 * that has any widget on it, each holding every widget for that page.
 */
export function placeholdersForSigner(
  placements: FieldPlacement[],
): Array<{ pageNumber: number; pos: Array<Record<string, unknown>> }> {
  const byPage = new Map<number, Array<Record<string, unknown>>>();

  for (const [index, field] of placements.entries()) {
    const page = Math.max(1, Math.round(field.pageNumber));
    const type = widgetType(field.type);

    const widget: Record<string, unknown> = {
      xPosition: field.x * REFERENCE_PAGE_WIDTH,
      yPosition: field.y * REFERENCE_PAGE_HEIGHT,
      Width: field.width * REFERENCE_PAGE_WIDTH,
      Height: field.height * REFERENCE_PAGE_HEIGHT,
      // Already in reference units, so nothing is left to divide out.
      scale: 1,
      // Stable within a document, and what the editor uses to address a widget.
      key: index,
      zIndex: index + 1,
      isStamp: type === 'stamp',
      type,
      options: {
        name: type,
        status: field.required ? 'required' : 'optional',
        ...(field.label ? { hint: field.label } : {}),
        ...(field.options ?? {}),
      },
    };

    const existing = byPage.get(page);
    if (existing) existing.push(widget);
    else byPage.set(page, [widget]);
  }

  return [...byPage.entries()]
    // Ascending, so the stored order matches reading order rather than the
    // order somebody happened to drop fields in.
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber, pos]) => ({ pageNumber, pos }));
}

/**
 * Attach placements to the signers they belong to.
 *
 * Matched on email, lowercased, because that is the only identifier shared
 * between a Scentic participant and an OpenSign placeholder — and because
 * linkContactToDoc compares the same way.
 */
export function buildPlaceholders(
  signers: Array<{ email: string; role: string }>,
  fields: FieldPlacement[],
): Array<Record<string, unknown>> {
  return signers.map((signer) => {
    const email = signer.email.trim().toLowerCase();
    const mine = fields.filter((f) => (f.signerEmail ?? '').trim().toLowerCase() === email);

    return {
      Role: signer.role.toLowerCase(),
      email,
      // An empty array is meaningful, not a gap: it tells OpenSign this signer
      // has no predefined fields and may place their own signature. That is the
      // behaviour every document had before placements existed, so it stays the
      // answer when none were drawn.
      placeHolder: placeholdersForSigner(mine),
    };
  });
}
