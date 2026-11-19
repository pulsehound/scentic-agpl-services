// SPDX-License-Identifier: AGPL-3.0-or-later
//
// deploy/opensign-ceremony/scentic-ceremony.js, loaded into a small page shaped like OpenSign's
// signing page (the class names and structure the script reads, copied from upstream's source:
// primitives/PdfDeclineModal.jsx, primitives/HandleError.jsx, the page header's arrows).
//
// jsdom lays nothing out, so what is proven is behaviour — what the script clicks, shows and never
// touches — not how it looks; and against this stand-in, not the live page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { ceremonyScript, localeWith, stateWords } from '../opensign-frontend-patches.mjs';
import { DEPLOY } from './helpers.mjs';

const CEREMONY = join(DEPLOY, 'opensign-ceremony');
const words = JSON.parse(readFileSync(join(CEREMONY, 'words.json'), 'utf8'));
const strings = localeWith(Object.fromEntries(Object.keys(words.locale).map(k => [k, ''])), words.locale);
const SCRIPT = ceremonyScript(readFileSync(join(CEREMONY, 'scentic-ceremony.js'), 'utf8'), stateWords(strings, words.states));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let dom;
afterEach(() => { dom?.window.close(); dom = null; });

/**
 * A signing page of `pages`: each a list of fields, 'mine' (opens a panel when its face is
 * clicked), 'mine-date' (filled by the page, opens nothing) or 'theirs' (another signer's, dimmed).
 */
async function page({ path = '/recipientSignPdf/doc1/contact1', pages = [['mine']], arrows = 2, ready = true } = {}) {
  dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
    url: `https://sign.test${path}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.Element.prototype.scrollIntoView = function () {};
  const clicks = { finish: 0, decline: 0, fields: [] };
  const root = document.getElementById('root');
  let current = 0;

  const header = document.createElement('div');
  if (ready) header.setAttribute('data-tut', 'reactourFifth');
  const buttons = [];
  for (let i = 0; i < arrows; i++) {
    const b = document.createElement('button');
    b.className = 'op-btn op-btn-neutral op-btn-xs';
    buttons.push(b);
    header.appendChild(b);
  }
  const finish = document.createElement('button');
  finish.className = 'op-btn op-btn-primary';
  finish.textContent = 'Finish';
  finish.addEventListener('click', () => clicks.finish++);
  const decline = document.createElement('button');
  decline.className = 'op-btn op-btn-secondary';
  decline.textContent = 'Decline';
  decline.addEventListener('click', () => clicks.decline++);
  header.append(finish, decline);
  const sheet = document.createElement('div');
  root.append(header, sheet);

  function draw() {
    sheet.replaceChildren();
    document.querySelectorAll('dialog.field-panel').forEach(d => d.remove());
    for (const [i, kind] of pages[current].entries()) {
      const field = document.createElement('div');
      field.className = 'signYourselfBlock';
      field.dataset.kind = kind;
      field.dataset.page = String(current + 1);
      // jsdom computes no default styles: a browser reports opacity 1 for a field left alone.
      field.style.opacity = kind === 'theirs' ? '0.5' : '1';
      const face = document.createElement('div');
      face.className = 'flex items-stretch';
      face.addEventListener('click', () => {
        clicks.fields.push(`${current + 1}:${kind}:${i}`);
        if (kind !== 'mine') return;
        const panel = document.createElement('dialog');
        panel.className = 'op-modal op-modal-open field-panel';
        root.appendChild(panel);
      });
      field.appendChild(face);
      sheet.appendChild(field);
    }
    if (buttons.length === 2) {
      buttons[0].disabled = current === 0;
      buttons[1].disabled = current === pages.length - 1;
    }
  }
  if (buttons.length === 2) {
    buttons[0].addEventListener('click', () => { if (current > 0) { current--; draw(); } });
    buttons[1].addEventListener('click', () => { if (current < pages.length - 1) { current++; draw(); } });
  }
  draw();
  window.eval(SCRIPT);
  // The script starts once the document has loaded, which jsdom reports a moment after it is made.
  await wait(30);

  const $ = sel => document.querySelector(sel);
  return {
    window,
    document,
    clicks,
    root,
    bar: () => $('.scentic-bar'),
    hint: () => $('.scentic-bar__hint').textContent,
    start: () => $('.scentic-bar__start'),
    notice: () => $('.scentic-notice'),
    currentPage: () => current + 1,
    goTo: n => { current = n - 1; draw(); },
    /** OpenSign's own panel, as PdfDeclineModal draws it. */
    modal(title, body, { reason = false } = {}) {
      const dialog = document.createElement('dialog');
      dialog.className = 'op-modal op-modal-open absolute z-[448] page-modal';
      const box = document.createElement('div');
      box.className = 'op-modal-box p-0';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const div = document.createElement('div');
      div.textContent = body;
      box.append(h3, div);
      if (reason) box.appendChild(document.createElement('textarea'));
      dialog.appendChild(box);
      root.appendChild(dialog);
      return dialog;
    },
    /** OpenSign's error line in place of the document, as HandleError draws it. */
    errorInPlaceOfDocument(text) {
      root.replaceChildren();
      const wrap = document.createElement('div');
      wrap.className = 'flex justify-center items-center h-[100vh]';
      const span = document.createElement('span');
      span.className = 'p-[15px] md:p-0 text-[20px] text-[gray]';
      span.textContent = text;
      wrap.appendChild(span);
      root.appendChild(wrap);
    },
  };
}
// The script looks again 150 ms after the page changes.
const settle = () => wait(260);

describe('the bar and Start', () => {
  it('the bar is there on the signing page, with one sentence and a Start button', async () => {
    const p = await page();
    expect(p.bar()).not.toBeNull();
    expect(p.bar().hidden).toBe(false);
    expect(p.bar().getAttribute('role')).toBe('banner');
    expect(p.document.body.firstElementChild).toBe(p.bar());
    expect(p.hint()).toBe('Review the document, complete the marked fields, then choose Finish.');
    expect(p.start().hidden).toBe(false);
    expect(p.start().textContent).toBe('Start');
    expect(p.start().type).toBe('button');
    expect(p.document.documentElement.getAttribute('data-scentic-view')).toBe('sign');
  });

  it('on the code screen the bar is there without Start; on any other page there is no bar', async () => {
    const code = await page({ path: '/login/abc' });
    expect(code.bar().hidden).toBe(false);
    expect(code.start().hidden).toBe(true);
    expect(code.hint()).toBe('Secure electronic signature');
    dom.window.close();
    const other = await page({ path: '/dashboard' });
    expect(other.bar().hidden).toBe(true);
  });

  it("Start passes over pages holding only another signer's fields and opens the signer's first field", async () => {
    const p = await page({ pages: [['theirs'], ['theirs', 'theirs'], ['mine-date', 'mine'], ['mine']] });
    p.goTo(2); // wherever the signer had got to, Start begins from the first page
    p.start().click();
    await wait(2600);
    expect(p.currentPage()).toBe(3);
    // Another signer's field was never clicked; a date the page fills itself was tried and passed.
    expect(p.clicks.fields).toEqual(['3:mine-date:0', '3:mine:1']);
    expect(p.document.querySelector('dialog.field-panel')).not.toBeNull();
    expect(p.hint()).toBe('Complete each marked field, then choose Finish.');
    expect(p.start().hidden).toBe(true);
    expect(p.document.querySelector('.scentic-next-field').dataset.kind).toBe('mine');
  }, 15_000);

  it('Start never clicks Finish or Decline, whatever it finds', async () => {
    for (const pages of [[['mine']], [['theirs'], ['theirs']], [['mine-date']]]) {
      const p = await page({ pages });
      p.start().click();
      await wait(1500);
      expect(p.clicks.finish, JSON.stringify(pages)).toBe(0);
      expect(p.clicks.decline, JSON.stringify(pages)).toBe(0);
      dom.window.close();
    }
  }, 15_000);

  it('with no field of theirs to open, it says only what is true', async () => {
    const p = await page({ pages: [['theirs'], ['theirs']] });
    p.start().click();
    await wait(1500);
    expect(p.clicks.fields).toEqual([]);
    expect(p.hint()).toBe('Review the document, then choose Finish. The page points to anything still to complete.');
    expect(p.start().hidden).toBe(true);
  }, 15_000);

  it("Start is withdrawn when the page is not the shape it knows: no page arrows, or the page's own controls not there yet", async () => {
    for (const shape of [{ arrows: 0 }, { arrows: 1 }, { arrows: 3 }, { ready: false }]) {
      const p = await page(shape);
      expect(p.start().hidden, JSON.stringify(shape)).toBe(true);
      expect(p.hint(), JSON.stringify(shape)).toBe('Secure electronic signature');
      expect(p.bar().hidden).toBe(false);
      dom.window.close();
    }
  });

  it('Start is not offered while a notice of the page is in front of it', async () => {
    const p = await page();
    const consent = p.document.createElement('dialog');
    consent.setAttribute('open', '');
    p.root.appendChild(consent);
    await settle();
    expect(p.start().hidden).toBe(true);
    consent.remove();
    await settle();
    expect(p.start().hidden).toBe(false);
  });

  it('if the page breaks under it mid-way, Start goes away and nothing else changes', async () => {
    const p = await page({ pages: [['mine']] });
    p.window.Element.prototype.scrollIntoView = function () { throw new Error('page changed shape'); };
    p.start().click();
    await wait(600);
    expect(p.start().hidden).toBe(true);
    expect(p.clicks.finish + p.clicks.decline).toBe(0);
    expect(p.bar().hidden).toBe(false);
  });
});

describe('the bar says where a closed document stands', () => {
  const declinedTitle = words.locale['document-declined'];

  it('after the signer declines, it no longer says to complete the fields', async () => {
    const p = await page({ pages: [['mine']] });
    p.start().click();
    await wait(900);
    expect(p.hint()).toBe('Complete each marked field, then choose Finish.');
    p.document.querySelector('dialog.field-panel').remove();

    // "Are you sure?" — the panel with a box for the reason.
    const asking = p.modal(declinedTitle, words.locale['decline-alert-1'], { reason: true });
    await settle();
    expect(p.hint()).toBe('You are about to decline this document.');
    expect(p.start().hidden).toBe(true);

    // Declined.
    asking.remove();
    p.modal(declinedTitle, words.locale['decline-alert-2']);
    await settle();
    expect(p.hint()).toBe('This document was declined. It can no longer be signed.');
    expect(p.hint()).not.toContain('Complete each marked field');
    expect(p.start().hidden).toBe(true);
  }, 15_000);

  it('backing out of declining puts the earlier sentence back', async () => {
    const p = await page({ pages: [['mine']] });
    p.start().click();
    await wait(900);
    p.document.querySelector('dialog.field-panel').remove();
    const asking = p.modal(declinedTitle, words.locale['decline-alert-1'], { reason: true });
    await settle();
    asking.remove();
    await settle();
    expect(p.hint()).toBe('Complete each marked field, then choose Finish.');
  }, 15_000);

  it('declined by somebody else, before this signer started: no Start', async () => {
    const p = await page();
    p.modal(declinedTitle, `${words.locale['decline-alert-3']} ${words.locale['decline-by']} : other@example.com`);
    await settle();
    expect(p.hint()).toBe('This document was declined. It can no longer be signed.');
    expect(p.start().hidden).toBe(true);
  });

  it('expired', async () => {
    const p = await page();
    p.modal(words.locale['expired-doc-title'], 'This document could be signed until 1 Nov 2026.');
    await settle();
    expect(p.hint()).toBe('This request has expired. Please contact the person who sent it to you.');
    expect(p.start().hidden).toBe(true);
  });

  it('finished', async () => {
    for (const key of words.states.finished) {
      const p = await page();
      p.modal('', words.locale[key]);
      await settle();
      expect(p.hint(), key).toBe('Thank you. Your part is done.');
      expect(p.start().hidden, key).toBe(true);
      dom.window.close();
    }
  });

  it('a withdrawn or unavailable link: the error line in place of the document', async () => {
    const p = await page();
    p.errorInPlaceOfDocument(words.locale['document-deleted']);
    await settle();
    expect(p.hint()).toBe('This link is no longer available. Please contact the person who sent it to you.');
    expect(p.start().hidden).toBe(true);
  });

  it("the document's own text never closes it: only the page's panels and error line are read", async () => {
    const p = await page();
    const text = p.document.createElement('div');
    text.className = 'react-pdf__Page__textContent';
    text.textContent = `${declinedTitle} ${words.locale['document-signed-alert-4']} ${words.locale['expired-doc-title']}`;
    p.root.appendChild(text);
    // A panel of the page's with some other title.
    p.modal('Add signature', 'Draw or type your signature.').classList.remove('op-modal-open');
    await settle();
    expect(p.hint()).toBe('Review the document, complete the marked fields, then choose Finish.');
  });

  it('without the wording from the build it claims no closed state at all', async () => {
    dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://sign.test/recipientSignPdf/d/c', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(readFileSync(join(CEREMONY, 'scentic-ceremony.js'), 'utf8'));
    const box = dom.window.document.createElement('dialog');
    box.className = 'op-modal op-modal-open';
    box.innerHTML = `<div class="op-modal-box"><h3>${declinedTitle}</h3></div>`;
    dom.window.document.getElementById('root').appendChild(box);
    await settle();
    expect(dom.window.document.querySelector('.scentic-bar__hint').textContent).toBe('Secure electronic signature');
  });
});

describe('messages in the page instead of a browser dialog', () => {
  it('scenticNotice shows the message under the bar as text, announced, and Dismiss clears it', async () => {
    const p = await page({ path: '/login/abc' });
    expect(p.notice().hidden).toBe(true);
    p.window.scenticNotice('<img src=x onerror=alert(1)> We couldn’t open this just now.');
    expect(p.notice().hidden).toBe(false);
    expect(p.notice().getAttribute('role')).toBe('alert');
    expect(p.notice().querySelector('img')).toBeNull();
    expect(p.notice().querySelector('.scentic-notice__text').textContent).toBe('<img src=x onerror=alert(1)> We couldn’t open this just now.');
    expect(p.bar().nextElementSibling).toBe(p.notice());
    p.notice().querySelector('.scentic-notice__dismiss').click();
    expect(p.notice().hidden).toBe(true);
    expect(p.notice().querySelector('.scentic-notice__text').textContent).toBe('');
  });

  it('a later message replaces an earlier one; nothing, null or undefined clears it', async () => {
    const p = await page({ path: '/login/abc' });
    p.window.scenticNotice('one');
    p.window.scenticNotice('two');
    expect(p.document.querySelectorAll('.scentic-notice')).toHaveLength(1);
    expect(p.notice().textContent).toContain('two');
    expect(p.notice().textContent).not.toContain('one');
    p.window.scenticNotice(undefined);
    expect(p.notice().hidden).toBe(true);
  });

  it('a message does not follow the signer to another screen', async () => {
    const p = await page({ path: '/login/abc' });
    p.window.scenticNotice('That code isn’t right.');
    p.window.history.pushState({}, '', '/recipientSignPdf/doc1/contact1');
    p.root.appendChild(p.document.createElement('div'));
    await settle();
    expect(p.notice().hidden).toBe(true);
  });
});
