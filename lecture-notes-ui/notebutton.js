/* AQ Learning - the "Get notes" button.

   AQ.noteButton(video, { onView(video) }) -> <button class="nbtn">
   Renders from AQ.notesJobs.status(video.id) and updates live:
     none            "Get notes" (doc icon); click starts a job
     queued/running  progressive button: a silver fill grows left -> right with the percentage, label "Preparing notes... 42%"
                     (stage-aware), shimmer while the percentage is unknown; role=progressbar + aria-valuenow + aria-busy
     ready           when it just finished: fill completes, a soft light sweep, a check draws, then it morphs into the white
                     "View notes" button; click -> onView(video)
     error           "Retry" with the message in the tooltip
   The subscription is released automatically when the button leaves the DOM (or call button.dispose()). */
(function () {
  "use strict";
  var u = AQ.util, el = u.el;
  var SVG_NS = "http://www.w3.org/2000/svg";

  var registry = [];   // live buttons: {btn, off, seen}
  var sweeper = null, watching = false;

  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  function checkIcon() {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    s.setAttribute("class", "icon nbtn__check");
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
    p.setAttribute("pathLength", "1");
    p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2.6");
    p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }

  function stageLabel(st) {
    var p = st.pct > 0 ? " " + st.pct + "%" : "";
    var base = st.stage === "transcript" ? "Transcript" :
               st.stage === "notes" ? "Writing notes" :
               st.stage === "pdf" ? "Drawing" : "Preparing notes";
    if (st.state === "queued" && !st.jobId) return "Queued…";
    return base + "…" + p;
  }

  /* release buttons that left the DOM (checked once per burst of DOM changes) */
  function sweep() {
    sweeper = null;
    registry.slice().forEach(function (r) {
      if (r.btn.isConnected) r.seen = true;
      else if (r.seen) r.btn.dispose();
    });
  }
  function scheduleSweep() {
    if (sweeper) return;
    sweeper = (window.requestAnimationFrame || setTimeout)(sweep);
  }
  function watchDom() {
    if (watching || !window.MutationObserver) return;
    watching = true;
    new MutationObserver(scheduleSweep).observe(document.documentElement, { childList: true, subtree: true });
  }

  function noteButton(video, opts) {
    opts = opts || {};
    var jobs = AQ.notesJobs;
    var id = video.id;

    var btn = el("button", "nbtn");
    btn.type = "button";
    var fill = el("span", "nbtn__fill"); fill.setAttribute("aria-hidden", "true");
    var sheen = el("span", "nbtn__sheen"); sheen.setAttribute("aria-hidden", "true");
    var content = el("span", "nbtn__content");
    var slot = el("span", "nbtn__icon"); slot.setAttribute("aria-hidden", "true");
    var doc = u.icon("notes"); doc.classList.add("nbtn__doc");
    slot.appendChild(doc); slot.appendChild(checkIcon());
    var label = el("span", "nbtn__label");
    content.appendChild(slot); content.appendChild(label);
    btn.appendChild(fill); btn.appendChild(sheen); btn.appendChild(content);

    var prev = "none", timer = null, last = jobs.status(id);

    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function setLabel(t) { if (label.textContent !== t) label.textContent = t; }
    function plain() {
      btn.removeAttribute("role"); btn.removeAttribute("aria-busy"); btn.removeAttribute("aria-valuenow");
      btn.removeAttribute("aria-valuemin"); btn.removeAttribute("aria-valuemax"); btn.removeAttribute("aria-valuetext");
      btn.removeAttribute("aria-disabled");
    }

    function render(st, animate) {
      var state = st.state;
      var busy = state === "queued" || state === "running";
      clearTimer();
      btn.title = "";
      btn.removeAttribute("data-phase");

      if (busy) {
        var known = st.pct > 0;
        btn.dataset.state = "busy";
        btn.dataset.indeterminate = known ? "false" : "true";
        fill.style.transform = "scaleX(" + (known ? st.pct / 100 : 1) + ")";
        var text = stageLabel(st);
        setLabel(text);
        btn.setAttribute("role", "progressbar");
        btn.setAttribute("aria-busy", "true");
        btn.setAttribute("aria-disabled", "true");
        btn.setAttribute("aria-valuemin", "0"); btn.setAttribute("aria-valuemax", "100");
        if (known) btn.setAttribute("aria-valuenow", String(st.pct)); else btn.removeAttribute("aria-valuenow");
        btn.setAttribute("aria-valuetext", text);
        btn.setAttribute("aria-label", "Notes for " + (video.title || "this lecture") + ": " + text);
        btn.title = st.message || "";
        return;
      }

      plain();
      btn.dataset.indeterminate = "false";

      if (state === "ready") {
        btn.setAttribute("aria-label", "View notes for " + (video.title || "this lecture"));
        if (animate && !reduced()) {
          // completion: fill finishes -> light sweep + check draws -> morph into the white "View notes" button
          btn.dataset.state = "busy";
          fill.style.transform = "scaleX(1)";
          void btn.offsetWidth;
          btn.dataset.state = "done";
          btn.dataset.phase = "sweep";
          setLabel("Notes ready");
          btn.setAttribute("aria-busy", "true");
          timer = setTimeout(function () {
            btn.removeAttribute("aria-busy");
            btn.dataset.state = "ready"; btn.dataset.phase = "morph";
            setLabel("View notes");
            timer = setTimeout(function () { btn.removeAttribute("data-phase"); timer = null; }, 700);
          }, 1350);
        } else {
          btn.dataset.state = "ready";
          setLabel("View notes");
        }
        return;
      }

      if (state === "error") {
        btn.dataset.state = "error";
        setLabel("Retry");
        btn.title = st.error || st.message || "Something went wrong. Click to try again.";
        btn.setAttribute("aria-label", "Retry notes for " + (video.title || "this lecture") + ". " + (st.error || ""));
        return;
      }

      btn.dataset.state = "none";
      fill.style.transform = "scaleX(0)";
      setLabel("Get notes");
      btn.title = st.message || "";   // e.g. "Notes expired - generate again"
      btn.setAttribute("aria-label", "Get notes for " + (video.title || "this lecture"));
    }

    btn.addEventListener("click", function () {
      var st = jobs.status(id);
      if (st.state === "ready") { if (opts.onView) opts.onView(video); else { var l = jobs.urls(id); if (l) window.open(l.html, "_blank", "noopener"); } }
      else if (st.state === "error") jobs.retry(id);
      else if (st.state === "none") jobs.start(video);
    });

    var entry = { btn: btn, seen: false, off: null };
    entry.off = jobs.subscribe(function (vid, st) {
      if (vid !== id) return;
      var from = prev; prev = st.state;
      var wasBusy = from === "queued" || from === "running";
      render(st, wasBusy && st.state === "ready");
    });
    btn.dispose = function () {
      clearTimer();
      if (entry.off) { entry.off(); entry.off = null; }
      var i = registry.indexOf(entry); if (i >= 0) registry.splice(i, 1);
    };
    registry.push(entry);
    watchDom();
    // initial render (status() may flip a stale "ready" to "none" later; the subscription handles that)
    prev = last.state;
    render(last, false);
    return btn;
  }

  AQ.noteButton = noteButton;
})();
