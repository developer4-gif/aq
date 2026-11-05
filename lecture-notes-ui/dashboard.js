/* AQ Learning - dashboard + "coming soon" screens (vanilla JS, DOM APIs only, no innerHTML).
   AQ.dashboardView.mount(container) -> {destroy()}   grid with the streak card (AQ.streakView, guarded) top-left
   AQ.comingSoonView.mount(container, {title, text}) -> {destroy()} */
(function () {
  "use strict";
  var el = AQ.util.el;

  function greeting(d) {
    var h = (d || new Date()).getHours();
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  function placeholder(cls, title, text) {
    var s = el("section", "dash__slot dash__slot--soon " + cls);
    s.setAttribute("aria-label", title + " (coming soon)");
    s.appendChild(el("p", "dash__tag", "Coming soon"));
    s.appendChild(el("h2", "dash__slot-title", title));
    s.appendChild(el("p", "dash__slot-text muted", text));
    return s;
  }

  function mount(container) {
    var root = el("div", "dash");
    var head = el("header", "dash__head");
    var h1 = el("h1", "pagetitle", greeting()); h1.tabIndex = -1; h1.setAttribute("data-focus-fallback", "");
    head.appendChild(h1);
    head.appendChild(el("p", "muted dash__sub", "Here is how your learning is going."));
    root.appendChild(head);

    var grid = el("div", "dash__grid");
    var streakSlot = el("section", "dash__slot dash__slot--streak");
    streakSlot.setAttribute("aria-label", "Your streak");
    var streak = null;
    if (AQ.streakView && typeof AQ.streakView.mount === "function") {
      try { streak = AQ.streakView.mount(streakSlot); } catch (e) { streak = null; }
    }
    if (!streak) {
      streakSlot.classList.add("dash__slot--soon");
      streakSlot.appendChild(el("p", "dash__tag", "Streak"));
      streakSlot.appendChild(el("p", "dash__slot-text muted", "Your daily streak will show up here."));
    }
    grid.appendChild(streakSlot);
    grid.appendChild(placeholder("dash__slot--wide", "Continue learning", "Pick up the lecture you were watching."));
    grid.appendChild(placeholder("", "Weekly activity", "A gentle chart of the time you spend learning."));
    grid.appendChild(placeholder("", "Goals", "Set a target and track it here."));
    grid.appendChild(placeholder("", "Recent notes", "Your latest hand-drawn notes, one click away."));
    root.appendChild(grid);
    container.appendChild(root);

    return {
      destroy: function () {
        if (streak && typeof streak.destroy === "function") { try { streak.destroy(); } catch (e) { /* ignore */ } }
        streak = null;
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  function mountSoon(container, opts) {
    opts = opts || {};
    var box = el("div", "empty soon");
    box.appendChild(el("p", "dash__tag", "Coming soon"));
    var h1 = el("h1", "empty__title", opts.title || "Coming soon"); h1.tabIndex = -1; h1.setAttribute("data-focus-fallback", "");
    box.appendChild(h1);
    box.appendChild(el("p", "muted", opts.text || "We are still building this."));
    var a = el("a", "btn btn--ghost btn--sm", "Back to dashboard"); a.href = "#/dashboard";
    box.appendChild(a);
    container.appendChild(box);
    return { destroy: function () { if (box.parentNode) box.parentNode.removeChild(box); } };
  }

  AQ.dashboardView = { mount: mount, greeting: greeting };
  AQ.comingSoonView = { mount: mountSoon };
})();
