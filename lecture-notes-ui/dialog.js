/* AQ Learning - accessible modal dialog host (one dialog at a time).
   Uses the #modal markup in index.html. Focus is trapped inside, Esc / backdrop / close button dismiss it,
   focus returns to the opener (or to `restore()` / the page heading when the opener no longer exists).

   var d = AQ.dialog.open({ kind, title, wide, opener, restore, onClose });
   d.body (element to fill), d.setTitle(), d.setKind(), d.close(), d.element
   AQ.dialog.confirm({ title, message, confirmLabel, danger, opener, restore }, onConfirm) */
(function () {
  "use strict";
  var u = AQ.util, $ = u.$, el = u.el;

  var modal = $("#modal"), dialog = $(".modal__dialog", modal), mTitle = $("#modal-title"), mKind = $("#modal-kind"), mBody = $("#modal-body");
  var state = null; // {opener, restore, onClose}

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
  function focusables() {
    return Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
  }

  function isOpen() { return !modal.hidden; }

  function close() {
    if (!state) return;
    var s = state; state = null;
    modal.hidden = true;
    mBody.textContent = "";            // removing an iframe stops playback
    document.body.classList.remove("modal-open");
    if (s.onClose) { try { s.onClose(); } catch (e) { /* ignore */ } }
    var target = s.opener;
    if (!target || !target.isConnected) target = s.restore ? s.restore() : null;
    if (!target || !target.isConnected) target = $("[data-focus-fallback]") || $("#view");
    if (target && target.focus) target.focus();
  }

  function open(opts) {
    opts = opts || {};
    var opener = opts.opener || document.activeElement;
    if (state) close();
    state = { opener: opener, restore: opts.restore, onClose: opts.onClose };
    mKind.textContent = opts.kind || "";
    mKind.hidden = !opts.kind;
    mTitle.textContent = opts.title || "";
    dialog.classList.toggle("modal__dialog--wide", !!opts.wide);
    mBody.textContent = "";
    modal.hidden = false;
    document.body.classList.add("modal-open");
    var api = {
      body: mBody, element: dialog,
      setTitle: function (t) { mTitle.textContent = t; },
      setKind: function (k) { mKind.textContent = k; mKind.hidden = !k; },
      close: close,
      focus: function (node) { (node || dialog).focus(); }
    };
    dialog.focus();
    return api;
  }

  /* Callers build their content after open(); this focuses the right thing afterwards. */
  function focusInitial(node) { (node && node.focus ? node : dialog).focus(); }

  document.addEventListener("keydown", function (e) {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      var f = focusables();
      if (!f.length) { e.preventDefault(); dialog.focus(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || a === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      else if (!dialog.contains(a)) { e.preventDefault(); first.focus(); }
    }
  });
  modal.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) close(); });

  function confirmDialog(opts, onConfirm) {
    var d = open({ kind: opts.kind || "Please confirm", title: opts.title, opener: opts.opener, restore: opts.restore });
    var msg = el("p", "modal__text", opts.message || "");
    var row = el("div", "modal__row");
    var cancel = u.button("Cancel", { cls: "btn btn--ghost" });
    var ok = u.button(opts.confirmLabel || "Confirm", { cls: "btn " + (opts.danger ? "btn--danger" : "btn--white") });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", function () { onConfirm(); close(); });
    row.appendChild(cancel); row.appendChild(ok);
    d.body.appendChild(msg); d.body.appendChild(row);
    cancel.focus();
    return d;
  }

  AQ.dialog = { open: open, close: close, isOpen: isOpen, confirm: confirmDialog, focusInitial: focusInitial };
})();
