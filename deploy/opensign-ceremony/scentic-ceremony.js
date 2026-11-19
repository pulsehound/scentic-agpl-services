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
// It fails quiet: if OpenSign's page changes shape and a field or the page arrows are not found,
// the Start button is withdrawn and the page works as it did without this file.
(function () {
  'use strict';

  var FIELD = '.signYourselfBlock';
  var MAX_PAGES = 500;

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

  var bar, hint, start;
  var started = false;
  var busy = false;

  function buildBar() {
    bar = el('div', 'scentic-bar');
    bar.setAttribute('role', 'banner');
    var mark = el('span', 'scentic-bar__mark', 'SCENTIC');
    mark.setAttribute('aria-label', 'Scentic');
    hint = el('span', 'scentic-bar__hint');
    start = el('button', 'scentic-bar__start', 'Start');
    start.type = 'button';
    start.hidden = true;
    start.addEventListener('click', onStart);
    bar.appendChild(mark);
    bar.appendChild(el('span', 'scentic-bar__rule'));
    bar.appendChild(hint);
    bar.appendChild(start);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // OpenSign's page arrows: the two small neutral buttons beside "1 of N" in its header.
  function pageArrows() {
    var arrows = document.querySelectorAll('button.op-btn-neutral.op-btn-xs');
    return arrows.length === 2 ? { prev: arrows[0], next: arrows[1] } : null;
  }

  // The fields on the page in view, in reading order: top to bottom, then left to right.
  function fieldsInOrder() {
    return Array.prototype.slice.call(document.querySelectorAll(FIELD)).sort(function (a, b) {
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

  async function onStart() {
    if (busy) return;
    busy = true;
    try {
      // From the first page, so "the first field" is the first in the document.
      var guard = 0;
      var arrows = pageArrows();
      while (arrows && !arrows.prev.disabled && guard++ < MAX_PAGES) {
        arrows.prev.click();
        await wait(80);
        arrows = pageArrows();
      }
      guard = 0;
      var fields = fieldsInOrder();
      while (!fields.length && guard++ < MAX_PAGES) {
        arrows = pageArrows();
        if (!arrows || arrows.next.disabled) break;
        arrows.next.click();
        await wait(300);
        fields = fieldsInOrder();
      }
      started = true;
      start.hidden = true;
      if (!fields.length) {
        // Nothing to take them to. Say nothing false; step aside.
        hint.textContent = 'Review the document. When you are ready, choose Finish.';
        return;
      }
      hint.textContent = 'Complete each marked field, then choose Finish.';
      fields[0].scrollIntoView({ block: 'center' });
      // The first field that opens: a date the page fills in itself, or one that is another
      // signer's, does not, and the next in order is tried.
      for (var i = 0; i < fields.length; i++) {
        openField(fields[i]);
        await wait(350);
        if (fieldPanelOpen()) {
          mark(fields[i]);
          return;
        }
      }
      mark(fields[0]);
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
    if (v === 'sign') {
      if (!started && !busy) {
        var ready = !!document.querySelector('[data-tut="reactourFifth"]') && !!pageArrows();
        hint.textContent = ready
          ? 'Review the document, complete the marked fields, then choose Finish.'
          : 'Secure electronic signature';
        // Offered once the page's own controls are there and no notice is in front of them.
        start.hidden = !ready || dialogOpen();
      }
    } else {
      started = false;
      start.hidden = true;
      hint.textContent = 'Secure electronic signature';
    }
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
