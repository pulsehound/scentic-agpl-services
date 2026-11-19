// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A thin layer over OpenSign's signing page, added to index.html at image build
// (deploy/opensign-frontend-patches.mjs). It adds two things and changes nothing a signer does:
//
//  1. A bar above the page with the platform's mark and, on the signing page, one sentence saying
//     what to do.
//  2. A "Start" button. A signer opened a contract on page 1 with its fields on the last page and
//     nothing saying where to begin. Start goes to the first page that has a field for them and
//     opens it; from there OpenSign's own "Next field ... Done" carries them through, and its own
//     Finish ends the ceremony.
//
// What it must never do: finish, decline or fill anything on the signer's behalf. Start only turns
// pages and clicks a field the signer could have clicked. It never clicks Finish, because
// OpenSign's Finish signs at once when nothing required is left, and that act is the signer's.
//
//  3. The bar says where the signer stands when there is nothing left to do: the document was
//     declined, the request expired or was withdrawn, or their part is finished. It used to go on
//     saying "Complete each marked field" over a document nobody could sign any more.
//  4. A place for the page's own short messages. OpenSign raised a browser dialog (alert) when a
//     link could not be opened; a dialog that blocks the whole tab, titled with the site's address,
//     for a counterparty who has done nothing wrong. Those messages are shown in the page instead
//     (window.scenticNotice, which the patched page calls in place of alert).
//
// It fails quiet: if OpenSign's page changes shape and a field or the page arrows are not found,
// the Start button is withdrawn and the page works as it did without this file.
(function () {
  'use strict';

  var FIELD = '.signYourselfBlock';
  var MAX_PAGES = 500;
  // Start gives up looking after this long, and says so truthfully. Long enough for every page it
  // may turn (350 ms each): a signature block on the last page of a long contract is the case
  // Start exists for.
  var MAX_SEARCH_MS = MAX_PAGES * 400;

  function view() {
    var p = location.pathname;
    if (p.indexOf('/login/') === 0) return 'code';
    if (/\/(load\/)?recipientSignPdf\//.test(p)) return 'sign';
    return 'other';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // The page's own titles and sentences for a document that is closed, as this build words them
  // (deploy/opensign-ceremony/words.json, written in front of this file at image build). Without
  // them the bar simply never claims a closed state.
  var WORDS = window.SCENTIC_STATE_WORDS || {};
  var HINTS = {
    declining: 'You are about to decline this document.',
    declined: 'This document was declined. It can no longer be signed.',
    expired: 'This request has expired. Please contact the person who sent it to you.',
    unavailable: 'This link is no longer available. Please contact the person who sent it to you.',
    finished: 'Thank you. Your part is done.',
  };

  var bar, hint, start, notice, noticeText;
  var started = false;
  var busy = false;
  // What the bar said while the document was open, to say again if a closed state goes away
  // (the signer backs out of declining).
  var openHint = '';
  var noticeView = '';

  function buildBar() {
    bar = el('div', 'scentic-bar');
    bar.setAttribute('role', 'banner');
    var mark = el('span', 'scentic-bar__mark', 'SCENTIC');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'Scentic');
    hint = el('span', 'scentic-bar__hint');
    hint.setAttribute('aria-live', 'polite');
    start = el('button', 'scentic-bar__start', 'Start');
    start.type = 'button';
    start.hidden = true;
    start.addEventListener('click', onStart);
    bar.appendChild(mark);
    bar.appendChild(el('span', 'scentic-bar__rule'));
    bar.appendChild(hint);
    bar.appendChild(start);
    document.body.insertBefore(bar, document.body.firstChild);

    notice = el('div', 'scentic-notice');
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    noticeText = el('span', 'scentic-notice__text');
    var dismiss = el('button', 'scentic-notice__dismiss', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', function () {
      showNotice('');
    });
    notice.appendChild(noticeText);
    notice.appendChild(dismiss);
    document.body.insertBefore(notice, bar.nextSibling);
  }

  // A message from the page, in the page. Text only: whatever it is given is shown as written.
  function showNotice(message) {
    if (!bar || !document.body.contains(bar)) buildBar();
    var text = message == null ? '' : String(message);
    noticeText.textContent = text;
    notice.hidden = text === '';
    noticeView = text === '' ? '' : view();
  }
  window.scenticNotice = showNotice;

  function trimmed(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  // Where the document stands, read from what the page itself is showing: 'open' while it can
  // still be signed. Only ever from the page's own dialogs and its error line, never from the
  // document's text.
  function pageState() {
    var boxes = document.querySelectorAll('.op-modal-open .op-modal-box, dialog[open] .op-modal-box');
    for (var i = 0; i < boxes.length; i++) {
      var title = trimmed(boxes[i].querySelector('h3'));
      if (WORDS.declinedTitle && title === WORDS.declinedTitle) {
        // The same panel asks "are you sure?" (with a box for the reason) and says it is done.
        return boxes[i].querySelector('textarea') ? 'declining' : 'declined';
      }
      if (WORDS.expiredTitle && title === WORDS.expiredTitle) return 'expired';
      var said = trimmed(boxes[i]);
      var finished = WORDS.finished || [];
      for (var j = 0; j < finished.length; j++) {
        if (finished[j] && said.indexOf(finished[j]) !== -1) return 'finished';
      }
    }
    // The page's error line in place of the document: one grey sentence and nothing to sign.
    var error = document.querySelector('#root span.text-\\[gray\\]');
    if (error && trimmed(error) !== '' && !pageArrows() && !document.querySelector(FIELD)) return 'unavailable';
    return 'open';
  }

  // OpenSign's page arrows: the two small neutral buttons beside "1 of N" in its header.
  function pageArrows() {
    var arrows = document.querySelectorAll('button.op-btn-neutral.op-btn-xs');
    return arrows.length === 2 ? { prev: arrows[0], next: arrows[1] } : null;
  }

  // This signer's fields on the page in view, in reading order: top to bottom, then left to right.
  // OpenSign draws another signer's fields too, dimmed; those are not this signer's to be taken to.
  function fieldsInOrder() {
    return Array.prototype.slice
      .call(document.querySelectorAll(FIELD))
      .filter(function (field) {
        return parseFloat(getComputedStyle(field).opacity) >= 1;
      })
      .sort(function (a, b) {
        var ra = a.getBoundingClientRect();
        var rb = b.getBoundingClientRect();
        return ra.top - rb.top || ra.left - rb.left;
      });
  }

  // OpenSign listens on the field's inner face, not its frame.
  function openField(field) {
    var face = field.querySelector('.flex.items-stretch') || field;
    face.click();
  }

  function fieldPanelOpen() {
    return !!document.querySelector('dialog.op-modal-open, .op-modal.op-modal-open');
  }

  // The consent notice, a field's own panel, or any other dialog of the page's.
  function dialogOpen() {
    return !!document.querySelector('.op-modal-open, .op-modal[open], dialog[open]');
  }

  function mark(field) {
    field.classList.add('scentic-next-field');
    setTimeout(function () {
      field.classList.remove('scentic-next-field');
    }, 4000);
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // The first of this signer's fields on the page in view that opens a panel, opened; or null. A
  // date the page fills in itself does not open one, and the next in order is tried.
  async function openFirstOnPage() {
    var fields = fieldsInOrder();
    for (var i = 0; i < fields.length; i++) {
      fields[i].scrollIntoView({ block: 'center' });
      openField(fields[i]);
      await wait(350);
      if (fieldPanelOpen()) return fields[i];
    }
    return null;
  }

  async function onStart() {
    if (busy) return;
    busy = true;
    start.hidden = true;
    hint.textContent = 'Looking for your first field\u2026';
    try {
      // From the first page, so "the first field" is the first in the document.
      var guard = 0;
      var arrows = pageArrows();
      while (arrows && !arrows.prev.disabled && guard++ < MAX_PAGES) {
        arrows.prev.click();
        await wait(80);
        arrows = pageArrows();
      }
      // Page by page until one of this signer's fields opens: a page holding only another signer's
      // fields is passed over. The clock starts here, after the pages were turned back.
      var began = Date.now();
      guard = 0;
      var opened = await openFirstOnPage();
      while (!opened && guard++ < MAX_PAGES && Date.now() - began < MAX_SEARCH_MS) {
        arrows = pageArrows();
        if (!arrows || arrows.next.disabled) break;
        arrows.next.click();
        await wait(350);
        opened = await openFirstOnPage();
      }
      started = true;
      start.hidden = true;
      if (opened) {
        mark(opened);
        openHint = 'Complete each marked field, then choose Finish.';
      } else {
        // Nothing was opened for them. Say only what is true: the page's own Finish points to
        // anything still to complete.
        openHint = 'Review the document, then choose Finish. The page points to anything still to complete.';
      }
      hint.textContent = openHint;
    } catch (e) {
      start.hidden = true;
      started = true;
    } finally {
      busy = false;
    }
  }

  function refresh() {
    var v = view();
    document.documentElement.setAttribute('data-scentic-view', v);
    if (!bar || !document.body.contains(bar)) buildBar();
    if (noticeView && noticeView !== v) showNotice('');
    if (v === 'sign') {
      var state = busy ? 'open' : pageState();
      if (state !== 'open') {
        // Nothing left to start: say where the document stands instead of what to fill in.
        hint.textContent = HINTS[state];
        start.hidden = true;
      } else if (!started && !busy) {
        var ready = !!document.querySelector('[data-tut="reactourFifth"]') && !!pageArrows();
        hint.textContent = ready
          ? 'Review the document, complete the marked fields, then choose Finish.'
          : 'Secure electronic signature';
        // Offered once the page's own controls are there and no notice is in front of them.
        start.hidden = !ready || dialogOpen();
      } else if (started && !busy && openHint) {
        // Back from a closed state that went away (declining was cancelled).
        hint.textContent = openHint;
      }
    } else {
      started = false;
      openHint = '';
      start.hidden = true;
      hint.textContent = 'Secure electronic signature';
    }
    // On the signer's pages only: the code screen and the signing page.
    bar.hidden = v === 'other';
  }

  function boot() {
    refresh();
    // A single-page app: routes and panels change without a load.
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        refresh();
      }, 150);
    }).observe(document.getElementById('root') || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'open'],
    });
    window.addEventListener('popstate', refresh);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
