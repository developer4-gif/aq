/* AQ Learning - center notes panel content.
   AQ.notesView.mount(container, video, { onClose }) -> { destroy() }
   Renders a header (title, channel, Download PDF, Open in new tab, Close) and a body that shows the generated notebook
   (notes.html from the notes server) in an iframe once ready, or the progressive AQ.noteButton while it is not.
   Depends on C1's AQ.notesJobs {status, subscribe, urls, start} and AQ.noteButton(video, {onView}); both are guarded.
   The notes server must allow framing of notes.html by this origin (CSP frame-ancestors, see server.py). */
(function () {
  "use strict";
  var AQ = window.AQ = window.AQ || {};
  var u = AQ.util, el = u.el;

  function jobs() { return AQ.notesJobs || null; }
  function getStatus(video) {
    var j = jobs();
    if (!j || typeof j.status !== "function") return { state: "none" };
    try { return j.status(video.id) || { state: "none" }; } catch (e) { return { state: "none" }; }
  }
  function getUrls(video) {
    var j = jobs();
    if (!j || typeof j.urls !== "function") return {};
    try { return j.urls(video.id) || {}; } catch (e) { return {}; }
  }
  function restart(video) {
    var j = jobs();
    if (!j) return;
    if (typeof j.retry === "function") j.retry(video.id);
    else if (typeof j.start === "function") j.start(video);
  }
  /* idle | running | ready | error */
  function modeOf(st) {
    var s = String((st && st.state) || "idle").toLowerCase();
    if (s === "done" || s === "ready") return "ready";
    if (s === "running" || s === "preparing" || s === "queued" || s === "pending" || s === "starting") return "running";
    if (s === "error" || s === "failed" || s === "offline") return "error";
    return "idle";
  }
  function dlIcon() {
    var ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    p.setAttribute("d", "M12 4v11M7 11l5 5 5-5M5 20h14");
    p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }
  function safeUrl(s) { return typeof s === "string" && /^https?:\/\//i.test(s) ? s : ""; }

  function mount(container, video, opts) {
    opts = opts || {};
    var root = el("section", "nview");
    root.setAttribute("aria-label", "Notes for " + video.title);
    var body = el("div", "nview__body");
    var shownMode = null, shownSrc = null, unsub = null, destroyed = false, loadTimer = 0;

    /* ----- header ----- */
    var head = el("header", "nview__head");
    var titles = el("div", "nview__titles");
    titles.appendChild(el("p", "eyebrow nview__eyebrow", "Lecture notes"));
    var h = el("h2", "nview__title", video.title);
    h.title = video.title;
    titles.appendChild(h);
    if (video.channel) titles.appendChild(el("p", "nview__channel", video.channel));
    var actions = el("div", "nview__actions");

    var pdfLink = el("a", "btn btn--ghost btn--sm nview__act");
    pdfLink.appendChild(dlIcon());
    pdfLink.appendChild(el("span", null, "Download PDF"));
    var tabLink = el("a", "btn btn--ghost btn--sm nview__act");
    tabLink.appendChild(u.icon("external"));
    tabLink.appendChild(el("span", null, "Open in new tab"));
    tabLink.target = "_blank"; tabLink.rel = "noopener";
    var closeBtn = el("button", "iconbtn nview__close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close notes");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", function () { if (typeof opts.onClose === "function") opts.onClose(); });
    actions.appendChild(pdfLink); actions.appendChild(tabLink); actions.appendChild(closeBtn);
    head.appendChild(titles); head.appendChild(actions);
    root.appendChild(head); root.appendChild(body);
    container.appendChild(root);

    function setLink(a, href) {
      if (href) { a.href = href; a.removeAttribute("aria-disabled"); a.classList.remove("is-off"); }
      else { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); a.classList.add("is-off"); }
    }

    /* ----- body states ----- */
    function drawReady(urls) {
      var src = safeUrl(urls.html);
      if (!src) return drawState("error", { message: "The finished notes could not be located. Try generating them again." });
      if (shownMode === "ready" && shownSrc === src) return;
      body.textContent = "";
      body.className = "nview__body nview__body--ready";
      var stage = el("div", "nview__stage");
      var skel = el("div", "nview__skeleton");
      skel.setAttribute("aria-hidden", "true");
      for (var i = 0; i < 3; i++) skel.appendChild(el("span", "nview__sheet"));
      var status = el("p", "sr", "Loading notes");
      status.setAttribute("role", "status");
      var frame = el("iframe", "nview__frame");
      frame.title = "Notes: " + video.title;
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.addEventListener("load", function () {
        clearTimeout(loadTimer);
        frame.classList.add("is-in");
        skel.classList.add("is-out");
        status.textContent = "Notes loaded";
        setTimeout(function () { if (skel.parentNode) skel.parentNode.removeChild(skel); }, 500);
      });
      /* a framing block gives no event: offer a way out if the page has not appeared after a while */
      loadTimer = setTimeout(function () {
        if (frame.classList.contains("is-in") || destroyed) return;
        var hint = el("p", "nview__hint");
        hint.appendChild(document.createTextNode("Taking a while? "));
        var a = el("a", null, "Open the notes in a new tab");
        a.href = src; a.target = "_blank"; a.rel = "noopener";
        hint.appendChild(a);
        stage.appendChild(hint);
      }, 12000);
      stage.appendChild(skel); stage.appendChild(frame); stage.appendChild(status);
      body.appendChild(stage);
      frame.src = src;
      shownSrc = src;
    }

    function drawState(mode, st) {
      if (shownMode === mode && mode !== "error") return;
      clearTimeout(loadTimer);
      shownSrc = null;
      body.textContent = "";
      body.className = "nview__body nview__body--state";
      var card = el("div", "nview__card nview__card--" + mode);
      var ic = el("span", "nview__ic");
      ic.appendChild(u.icon("notes"));
      card.appendChild(ic);
      if (mode === "error") {
        card.appendChild(el("h3", "nview__state-title", "Notes could not be made"));
        var msg = el("p", "nview__state-copy nview__error", (st && (st.error || st.message)) || "Something went wrong. Please try again.");
        msg.setAttribute("role", "alert");
        card.appendChild(msg);
        var retry = el("button", "btn btn--white", "Try again");
        retry.type = "button";
        retry.addEventListener("click", function () { restart(video); });
        card.appendChild(retry);
      } else {
        card.appendChild(el("h3", "nview__state-title", mode === "running" ? "Preparing your notes" : "Notes for this lecture aren’t ready yet"));
        card.appendChild(el("p", "nview__state-copy", mode === "running"
          ? "This usually takes a few minutes. You can keep watching or close this panel - progress is kept."
          : "Create hand-drawn notes from the lecture. It takes a few minutes, and they will appear right here."));
        var slot = el("div", "nview__btnslot");
        if (typeof AQ.noteButton === "function") {
          try {
            var nb = AQ.noteButton(video, { onView: render });
            var node = nb && nb.el ? nb.el : nb;
            if (node && node.nodeType === 1) slot.appendChild(node);
          } catch (e) { /* fall back to the plain button */ }
        }
        if (!slot.firstChild) {
          var go = el("button", "btn btn--white", "Generate notes");
          go.type = "button";
          go.addEventListener("click", function () {
            var j = jobs();
            if (j && typeof j.start === "function") j.start(video);
          });
          slot.appendChild(go);
        }
        card.appendChild(slot);
      }
      body.appendChild(card);
    }

    function render() {
      if (destroyed) return;
      var st = getStatus(video);
      var mode = modeOf(st);
      var urls = getUrls(video);
      setLink(pdfLink, mode === "ready" ? safeUrl(urls.pdf) : "");
      setLink(tabLink, mode === "ready" ? safeUrl(urls.html) : "");
      if (mode === "ready") drawReady(urls); else drawState(mode, st);
      shownMode = mode === "ready" && !shownSrc ? "error" : mode;
    }

    render();
    var j = jobs();
    if (j && typeof j.subscribe === "function") {
      try {
        var r = j.subscribe(function (id) { if (id === video.id) render(); });
        if (typeof r === "function") unsub = r;
      } catch (e) { /* no live updates */ }
    }

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(loadTimer);
        if (unsub) { try { unsub(); } catch (e) { /* ignore */ } }
        var f = root.querySelector("iframe");
        if (f) f.src = "about:blank";
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  AQ.notesView = { mount: mount };
})();
