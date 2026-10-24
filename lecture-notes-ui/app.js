/* AQ Learning - playlists screen: routing + rendering (vanilla JS, no build step).
   Routes:  #/  -> playlists home      #/playlist/<id>  -> playlist detail
   Sections: 1 setup + small UI helpers | 2 playlist form + delete | 3 home | 4 detail (add video, rows, drag) | 5 router
   All user text is written with textContent / DOM APIs (never innerHTML). */
(function () {
  "use strict";
  var u = AQ.util, S = AQ.store, D = AQ.dialog;
  var $ = u.$, el = u.el, icon = u.icon, button = u.button;

  /* ---------- 1. setup + small UI helpers ---------- */
  var view = $("#view"), searchForm = $("#search-form"), searchInput = $("#search");
  var liveEl = $("#live"), toastsEl = $("#toasts");
  var query = "";                 // lower-cased search text (home screen)
  var addOpen = false;            // detail: is the add-video panel open (when the playlist has videos)
  var addStatus = null;           // detail: {kind: ok|warn|error, msg, editId?}
  var pendingFocus = null;        // selector or function; applied after the next render

  function announce(text) { liveEl.textContent = ""; setTimeout(function () { liveEl.textContent = text; }, 30); }

  var toastTimer = null;
  function toast(msg, actionLabel, onAction) {
    toastsEl.textContent = "";
    clearTimeout(toastTimer);
    var t = el("div", "toast");
    t.appendChild(el("span", null, msg));
    if (actionLabel) {
      var b = button(actionLabel, { cls: "toast__btn" });
      b.addEventListener("click", function () { toastsEl.textContent = ""; clearTimeout(toastTimer); onAction(); });
      t.appendChild(b);
    }
    toastsEl.appendChild(t);
    toastTimer = setTimeout(function () { toastsEl.textContent = ""; }, 7000);
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /** Full-bleed cover: the first video's thumbnail fills the whole card, or an empty placeholder. */
  function coverEl(p) {
    var c = el("div", "cover");
    if (!p.videos.length) {
      c.classList.add("cover--empty");
      c.appendChild(icon("list"));
      c.appendChild(el("span", null, "No videos yet"));
      return c;
    }
    // 16:9 thumbnails have no letterbox bars: maxres (sharp) when the video has one, else mqdefault
    var id = p.videos[0].id, img = el("img");
    img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.src = "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/maxresdefault.jpg";
    img.addEventListener("load", function () {
      if (img.naturalWidth <= 120 && img.src.indexOf("maxres") > -1) img.src = "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/mqdefault.jpg";
    });
    img.addEventListener("error", function () {
      if (img.src.indexOf("maxres") > -1) img.src = "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/mqdefault.jpg";
      else img.style.visibility = "hidden";
    });
    c.appendChild(img);
    return c;
  }

  /** Standard progress bar: "N of M watched" + a thin track. */
  function progressEl(p) {
    var pr = AQ.store.progress(p);
    var wrap = el("div", "wprogress");
    var label = el("div", "wprogress__label");
    var tm = AQ.store.progressTime(pr);
    label.appendChild(el("span", null, !pr.total ? "Nothing to watch yet" : pr.timed ? pr.pct + "% watched" + (tm ? " · " + tm : "") : pr.done + " of " + pr.total + " watched"));
    if (!pr.timed) label.appendChild(el("span", "wprogress__pct", pr.pct + "%"));
    var track = el("div", "wprogress__track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Watched in " + p.name);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(pr.pct));
    var fill = el("span", "wprogress__fill");
    fill.style.width = pr.pct + "%";
    track.appendChild(fill);
    wrap.appendChild(label);
    wrap.appendChild(track);
    return wrap;
  }

  /** Home header: "Overall progress - 23% · 1 hr 2 min of 4 hr 30 min" across all playlists (unique videos). */
  function overallEl() {
    var pr = AQ.store.overall();
    var wrap = el("div", "woverall");
    if (!pr.total) { wrap.hidden = true; return wrap; }
    var tm = AQ.store.progressTime(pr);
    var label = el("div", "woverall__label");
    label.appendChild(el("span", "woverall__k", "Overall progress —"));
    label.appendChild(el("span", "woverall__v", pr.timed ? pr.pct + "%" + (tm ? " · " + tm : "") : pr.done + " of " + pr.total + " watched"));
    var track = el("div", "wprogress__track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Overall progress across all playlists");
    track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); track.setAttribute("aria-valuenow", String(pr.pct));
    var fill = el("span", "wprogress__fill"); fill.style.width = pr.pct + "%";
    track.appendChild(fill);
    wrap.appendChild(label); wrap.appendChild(track);
    return wrap;
  }

  /* ----- "..." card menu: one open at a time, Esc closes, arrow keys move ----- */
  var openMenu = null; // {btn, list, host}
  function closeMenu(refocus) {
    if (!openMenu) return;
    var m = openMenu; openMenu = null;
    m.list.hidden = true; m.btn.setAttribute("aria-expanded", "false");
    m.host.classList.remove("is-menu-open");
    if (refocus) m.btn.focus();
  }
  document.addEventListener("click", function (e) { if (openMenu && !openMenu.host.contains(e.target)) closeMenu(false); });

  function cardMenu(p, host) {
    var wrap = el("div", "menu");
    var btn = button("", { cls: "iconbtn menu__btn", icon: "dots", aria: "Playlist options: " + p.name });
    btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
    var list = el("div", "menu__list"); list.setAttribute("role", "menu"); list.setAttribute("aria-label", p.name); list.hidden = true;

    function item(label, cls, fn) {
      var b = el("button", "menu__item " + (cls || ""), label);
      b.type = "button"; b.setAttribute("role", "menuitem"); b.tabIndex = -1;
      b.addEventListener("click", function () { closeMenu(false); fn(b); });
      list.appendChild(b);
      return b;
    }
    item("Rename", "", function () { openPlaylistForm(p, btn); });
    item("Delete", "menu__item--danger", function () { confirmDelete(p, btn); });

    function openIt() {
      closeMenu(false);
      list.hidden = false; btn.setAttribute("aria-expanded", "true"); host.classList.add("is-menu-open");
      openMenu = { btn: btn, list: list, host: host };
      list.querySelector("button").focus();
    }
    btn.addEventListener("click", function () { if (openMenu && openMenu.btn === btn) closeMenu(true); else openIt(); });
    btn.addEventListener("keydown", function (e) { if (e.key === "ArrowDown") { e.preventDefault(); openIt(); } });
    list.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(list.querySelectorAll("button")), i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === "Tab") { closeMenu(false); }
    });
    wrap.appendChild(btn); wrap.appendChild(list);
    return wrap;
  }

  /* ---------- 2. playlist form (create / rename) + delete ---------- */
  function field(id, label, control, hint) {
    var f = el("div", "field");
    var l = el("label", null, label); l.htmlFor = id;
    f.appendChild(l); f.appendChild(control);
    if (hint) f.appendChild(hint);
    return f;
  }

  /** Create (p == null) or rename/edit (p given). */
  function openPlaylistForm(p, opener) {
    var L = S.LIMITS, editing = !!p;
    var d = D.open({
      kind: editing ? "Rename playlist" : "New playlist",
      title: editing ? "Rename playlist" : "Create a playlist",
      opener: opener,
      restore: p ? function () { return $('[data-pl-link="' + p.id + '"]'); } : null
    });
    var form = el("form", "form"); form.noValidate = true;

    var name = el("input"); name.id = "pl-name"; name.type = "text"; name.maxLength = L.name; name.required = true; name.autocomplete = "off";
    name.value = editing ? p.name : "";
    name.setAttribute("aria-describedby", "pl-name-count pl-name-err");
    var nameCount = el("span", "field__count"); nameCount.id = "pl-name-count";
    var nameErr = el("p", "field__err"); nameErr.id = "pl-name-err";

    var desc = el("textarea"); desc.id = "pl-desc"; desc.rows = 3; desc.maxLength = L.description;
    desc.value = editing ? p.description : "";
    desc.setAttribute("aria-describedby", "pl-desc-count");
    var descCount = el("span", "field__count"); descCount.id = "pl-desc-count";

    function counts() {
      nameCount.textContent = name.value.length + " / " + L.name;
      descCount.textContent = desc.value.length + " / " + L.description;
    }
    name.addEventListener("input", function () { name.removeAttribute("aria-invalid"); nameErr.textContent = ""; counts(); });
    desc.addEventListener("input", counts);
    counts();

    var nameHint = el("div", "field__meta"); nameHint.appendChild(nameErr); nameHint.appendChild(nameCount);
    var descHint = el("div", "field__meta"); descHint.appendChild(el("span", "muted", "Optional")); descHint.appendChild(descCount);
    form.appendChild(field("pl-name", "Name", name, nameHint));
    form.appendChild(field("pl-desc", "Description", desc, descHint));

    var row = el("div", "modal__row");
    var cancel = button("Cancel", { cls: "btn btn--ghost" });
    var save = button(editing ? "Save" : "Create playlist", { cls: "btn btn--white", type: "submit" });
    cancel.addEventListener("click", d.close);
    row.appendChild(cancel); row.appendChild(save); form.appendChild(row);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var n = name.value.trim(), err = "";
      if (!n) err = "Give your playlist a name.";
      else if (n.length > L.name) err = "Use at most " + L.name + " characters.";
      else if (S.nameTaken(n, editing ? p.id : null)) err = "You already have a playlist with this name.";
      if (err) { nameErr.textContent = err; name.setAttribute("aria-invalid", "true"); name.focus(); return; }
      if (editing) {
        S.update(p.id, n, desc.value);
        d.close();
        announce("Playlist renamed to " + n);
      } else {
        var created = S.create(n, desc.value);
        d.close();
        if (created) location.hash = "#/playlist/" + created.id;
      }
    });
    d.body.appendChild(form);
    name.focus(); name.select();
  }

  function confirmDelete(p, opener) {
    var n = p.videos.length;
    D.confirm({
      kind: "Delete playlist", title: "Delete “" + p.name + "”?",
      message: "This removes the playlist" + (n ? " and its " + plural(n, "video", "videos") : "") + " from this browser. The videos on YouTube are not affected. This cannot be undone.",
      confirmLabel: "Delete playlist", danger: true, opener: opener
    }, function () {
      var onDetail = route().name === "playlist";
      S.remove(p.id);
      announce("Playlist deleted");
      if (onDetail) location.hash = "#/";
    });
  }

  /* ---------- 3. home ---------- */
  var homeGrid = null, homeCount = null;

  function renderHome() {
    searchForm.hidden = false;
    document.title = "Your playlists - AQ Learning";
    view.textContent = "";

    var head = el("div", "pagehead");
    var left = el("div");
    var h1 = el("h1", "pagetitle", "Your playlists"); h1.tabIndex = -1; h1.setAttribute("data-focus-fallback", "");
    homeCount = el("p", "pagecount muted");
    left.appendChild(h1); left.appendChild(homeCount); left.appendChild(overallEl());
    var nb = AQ.water.button("New playlist", { icon: "plus", onActivate: function (b) { openPlaylistForm(null, b); } });
    var headActs = el("div", "pagehead__actions");
    var impBtn = button("Import from YouTube", { cls: "btn btn--ghost", icon: "youtube" });
    impBtn.setAttribute("data-act", "import");
    impBtn.addEventListener("click", function () { if (AQ.importPlaylist) AQ.importPlaylist.open(impBtn); });
    headActs.appendChild(impBtn); headActs.appendChild(nb);
    head.appendChild(left); head.appendChild(headActs);
    view.appendChild(head);

    homeGrid = el("div", "pgrid-wrap");
    view.appendChild(homeGrid);
    renderGrid();
  }

  function renderGrid() {
    var everything = S.all();
    var list = query ? everything.filter(function (p) { return p.name.toLowerCase().indexOf(query) >= 0; }) : everything;
    homeCount.textContent = query ? list.length + " of " + plural(everything.length, "playlist", "playlists") : plural(everything.length, "playlist", "playlists");
    homeGrid.textContent = "";

    if (!everything.length) {
      var empty = el("div", "empty");
      empty.appendChild(icon("list"));
      empty.appendChild(el("h2", "empty__title", "No playlists yet"));
      empty.appendChild(el("p", "muted", "Group lectures into playlists, watch them in order and generate hand-drawn notes."));
      var cb = button("Create your first playlist", { cls: "btn btn--white", icon: "plus" });
      cb.addEventListener("click", function () { openPlaylistForm(null, cb); });
      empty.appendChild(cb);
      homeGrid.appendChild(empty);
      return;
    }
    if (!list.length) {
      var none = el("div", "empty");
      none.appendChild(icon("search"));
      none.appendChild(el("h2", "empty__title", "No matching playlists"));
      none.appendChild(el("p", "muted", "Nothing is named like “" + searchInput.value.trim() + "”."));
      var clear = button("Clear search", { cls: "btn btn--ghost btn--sm" });
      clear.addEventListener("click", function () { searchInput.value = ""; query = ""; renderGrid(); searchInput.focus(); });
      none.appendChild(clear);
      homeGrid.appendChild(none);
      return;
    }

    var ul = el("ul", "pgrid");
    list.forEach(function (p) { ul.appendChild(playlistCard(p)); });
    homeGrid.appendChild(ul);
    chromaGrid(ul);
  }

  /* ----- "Chroma" card effect (grid-level colour spotlight + per-card glow; styles: .pgrid / .pcard--cover in styles.css) ----- */
  // Curated accent pairs for a royal-black UI (soft jewel tones, never neon). A playlist always gets the same pair (hash of its id).
  var ACCENTS = [
    ["#7f9cff", "#b9a4ff"],   // periwinkle / lavender
    ["#d9b56b", "#f4e3b5"],   // champagne gold
    ["#4fc9b8", "#8ec5ff"],   // teal / ice
    ["#e58ab0", "#b99aff"],   // rose / orchid
    ["#ff9f7a", "#ffd18a"],   // amber / apricot
    ["#6fd19b", "#c6e58f"],   // emerald / sage
    ["#a779ff", "#ff8fd0"],   // violet / pink
    ["#6cc4ff", "#9fb0ff"]    // sky / steel blue
  ];
  function accentFor(id) {
    var h = 2166136261;                                        // FNV-1a
    for (var i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ACCENTS[(h >>> 0) % ACCENTS.length];
  }

  var activeChroma = null;                                     // the grid on screen (to re-measure / repaint on scroll + resize)
  window.addEventListener("scroll", function () { if (activeChroma) activeChroma.scroll(); }, { passive: true });
  window.addEventListener("resize", function () { if (activeChroma) activeChroma.measure(); });

  /** The pointer drives a soft spotlight (--x/--y per card, --so intensity on the grid) that eases after the cursor
      with a frame-rate independent lerp (rAF runs only until it settles) and fades out on leave. Card rects are measured
      once (document coordinates; refreshed on resize / content resize) so the frame loop only writes custom properties.
      With prefers-reduced-motion the spotlight jumps instantly. */
  function chromaGrid(ul) {
    var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    var items = Array.prototype.slice.call(ul.children);       // <li> boxes never transform, so their rects stay stable on hover lift
    var cards = items.map(function (li) { return li.firstChild; });
    var box = [], off = [];                                    // box[k] = {l,t,r,b} in document coords; off[k] = hole parked away
    var PR = 300;                                              // spotlight radius, keep in sync with --pr in styles.css
    var cur = { x: 0, y: 0, i: 0 }, tgt = { x: 0, y: 0, i: 0 }, raf = 0, last = 0, seen = false;

    function measure() {
      var sx = window.pageXOffset, sy = window.pageYOffset;
      items.forEach(function (li, k) {
        var r = li.getBoundingClientRect();
        box[k] = { l: r.left + sx, t: r.top + sy, r: r.right + sx, b: r.bottom + sy };
      });
      if (seen) paint();
    }
    function paint() {                                         // writes only: no layout reads here
      var sx = window.pageXOffset, sy = window.pageYOffset, px = cur.x + sx, py = cur.y + sy, reach = PR * cur.i + 2;
      ul.style.setProperty("--so", cur.i.toFixed(3));
      for (var k = 0; k < cards.length; k++) {
        var bx = box[k], c = cards[k];
        var dx = Math.max(bx.l - px, 0, px - bx.r), dy = Math.max(bx.t - py, 0, py - bx.b);
        if (dx * dx + dy * dy > reach * reach) {               // spotlight can't reach this card: park the hole once
          if (!off[k]) { off[k] = true; c.style.setProperty("--x", "-9999px"); c.style.setProperty("--y", "-9999px"); }
          continue;
        }
        off[k] = false;
        c.style.setProperty("--x", (px - bx.l).toFixed(1) + "px");
        c.style.setProperty("--y", (py - bx.t).toFixed(1) + "px");
      }
    }
    function tick(now) {
      raf = 0;
      var dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
      var kp = 1 - Math.exp(-dt * 11), ki = 1 - Math.exp(-dt * (tgt.i > cur.i ? 9 : 5));
      cur.x += (tgt.x - cur.x) * kp; cur.y += (tgt.y - cur.y) * kp; cur.i += (tgt.i - cur.i) * ki;
      var done = Math.abs(tgt.x - cur.x) < 0.3 && Math.abs(tgt.y - cur.y) < 0.3 && Math.abs(tgt.i - cur.i) < 0.004;
      if (done) { cur.x = tgt.x; cur.y = tgt.y; cur.i = tgt.i; }
      paint();
      if (!done) raf = requestAnimationFrame(tick);
    }
    function go() {
      if (reduce.matches) { cur.x = tgt.x; cur.y = tgt.y; cur.i = tgt.i; paint(); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    }
    function onMove(e) {
      if (e.pointerType === "mouse" && e.type === "pointerdown" && e.button !== 0) return;
      seen = true;
      tgt.x = e.clientX; tgt.y = e.clientY;
      if (cur.i < 0.03) { cur.x = tgt.x; cur.y = tgt.y; }      // fade in where the pointer is instead of flying in
      tgt.i = 1;
      go();
    }
    function onLeave() { tgt.i = 0; go(); }
    function onScroll() {                                      // content moved under a still pointer: keep the hole on the cursor
      if (!seen || (cur.i < 0.004 && tgt.i === 0)) return;
      if (!raf) paint();
    }
    ul.addEventListener("pointermove", onMove);
    ul.addEventListener("pointerdown", onMove);                // touch: a tap places the spotlight too
    ul.addEventListener("pointerleave", onLeave);
    ul.addEventListener("pointercancel", onLeave);
    if (window.ResizeObserver) new ResizeObserver(measure).observe(ul);   // grid reflow (fonts, scrollbar, breakpoints)
    measure();
    activeChroma = { measure: measure, scroll: onScroll };
  }

  function playlistCard(p) {
    var li = el("li", "pgrid__item");
    var card = el("article", "pcard pcard--cover");
    var ac = accentFor(p.id);
    card.style.setProperty("--pc-a", ac[0]); card.style.setProperty("--pc-b", ac[1]);
    card.appendChild(coverEl(p));
    var fx = el("div", "pcard__fx"); fx.setAttribute("aria-hidden", "true");   // desaturating veil with the spotlight hole
    card.appendChild(fx);

    // name + stats + progress sit on a dark fade attached to the bottom of the cover
    var body = el("div", "pcard__body");
    var h2 = el("h2", "pcard__name");
    var a = el("a", null, p.name); a.href = "#/playlist/" + p.id; a.setAttribute("data-pl-link", p.id);
    h2.appendChild(a); body.appendChild(h2);
    body.appendChild(el("p", "pcard__meta", u.statsText(p)));
    body.appendChild(progressEl(p));
    card.appendChild(body);
    card.appendChild(cardMenu(p, card));
    li.appendChild(card);
    return li;
  }

  searchForm.addEventListener("submit", function (e) { e.preventDefault(); });
  searchInput.addEventListener("input", function () {
    query = searchInput.value.trim().toLowerCase();
    if (route().name === "home" && homeGrid) renderGrid();
  });

  /* ---------- 4. detail ---------- */
  function renderNotFound() {
    searchForm.hidden = true;
    document.title = "Playlist not found - AQ Learning";
    view.textContent = "";
    view.appendChild(backLink());
    var box = el("div", "empty");
    box.appendChild(icon("list"));
    var h1 = el("h1", "empty__title", "Playlist not found"); h1.tabIndex = -1; h1.setAttribute("data-focus-fallback", "");
    box.appendChild(h1);
    box.appendChild(el("p", "muted", "It may have been deleted, or the link is wrong."));
    var a = el("a", "btn btn--white", "Go to your playlists"); a.href = "#/";
    box.appendChild(a);
    view.appendChild(box);
  }

  function backLink() {
    var a = el("a", "backlink"); a.href = "#/";
    a.appendChild(el("span", null, "←")); a.lastChild.setAttribute("aria-hidden", "true");
    a.appendChild(document.createTextNode(" Playlists"));
    return a;
  }

  function renderDetail(p) {
    searchForm.hidden = true;
    document.title = p.name + " - AQ Learning";
    view.textContent = "";
    view.appendChild(backLink());

    var head = el("header", "dhead");
    head.appendChild(el("p", "eyebrow", "Playlist"));
    var h1 = el("h1", "pagetitle pagetitle--lg", p.name); h1.tabIndex = -1; h1.setAttribute("data-focus-fallback", "");
    head.appendChild(h1);
    if (p.description) head.appendChild(el("p", "dhead__desc", p.description));
    if (p.source && p.source.type === "youtube") {          // imported playlist: badge + link back to the original
      var srcRow = el("p", "dhead__source");
      var badge = el("span", "srcbadge"); badge.appendChild(icon("youtube")); badge.appendChild(el("span", null, "Imported from YouTube"));
      badge.title = "A local copy made on " + new Date(p.source.importedAt).toLocaleDateString();
      var srcLink = el("a", "srclink", "Open on YouTube"); srcLink.href = p.source.url; srcLink.target = "_blank"; srcLink.rel = "noopener noreferrer";
      srcLink.appendChild(icon("external"));
      srcRow.appendChild(badge); srcRow.appendChild(srcLink);
      head.appendChild(srcRow);
    }
    var pgr = S.progress(p);
    head.appendChild(el("p", "dhead__stats muted", u.statsText(p) + (pgr.total ? " · " + pgr.pct + "% watched" : "") + " · Updated " + u.timeAgo(p.updated)));

    var acts = el("div", "dhead__actions");
    var addBtn = button("Add video", { cls: "btn btn--white", icon: "plus" });
    addBtn.addEventListener("click", function () {
      addOpen = !addOpen || !p.videos.length;
      pendingFocus = addOpen ? "[data-add-input]" : null;
      render();
    });
    addBtn.setAttribute("aria-expanded", String(addOpen || !p.videos.length));
    var playBtn = button("Play all", { cls: "btn btn--ghost", icon: "play" });
    playBtn.disabled = !p.videos.length;
    playBtn.setAttribute("data-act", "playall");
    playBtn.addEventListener("click", function () {   // starts at the first unfinished video (resuming it), or at the top when all are done
      var first = 0;
      for (var k = 0; k < p.videos.length; k++) { if (!S.watchInfo(p.videos[k].id).done) { first = k; break; } }
      AQ.player.open({ queue: p.videos.slice(), index: first, opener: playBtn, restore: function () { return $('[data-act="playall"]', view); } });
    });
    var renBtn = button("Rename", { cls: "btn btn--ghost", icon: "pencil" });
    renBtn.addEventListener("click", function () { openPlaylistForm(p, renBtn); });
    var delBtn = button("Delete", { cls: "btn btn--ghost btn--danger", icon: "trash" });
    delBtn.addEventListener("click", function () { confirmDelete(p, delBtn); });
    [addBtn, playBtn, renBtn, delBtn].forEach(function (b) { acts.appendChild(b); });
    head.appendChild(acts);
    view.appendChild(head);

    if (!p.videos.length) {
      var empty = el("div", "empty empty--inline");
      empty.appendChild(icon("list"));
      empty.appendChild(el("h2", "empty__title", "This playlist is empty"));
      empty.appendChild(el("p", "muted", "Paste a YouTube link to add your first video."));
      empty.appendChild(addForm(p));
      view.appendChild(empty);
    } else {
      var af = addOpen ? addForm(p, true) : null;
      if (af) view.appendChild(af);
      var list = videoList(p);
      // split view: the list lives inside a shell that can morph it into a left nav (see split.js)
      view.appendChild(AQ.split ? AQ.split.shell({ playlist: p, list: list, hide: [head, af], openId: route().notes }) : list);
    }
  }

  /* ----- add video ----- */
  function fetchMeta(id) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    var url = "https://www.youtube.com/oembed?url=" + encodeURIComponent(u.watchUrl(id)) + "&format=json";
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (res) {
      if (!res.ok) throw new Error("oembed " + res.status);
      return res.json();
    }).then(function (d) {
      clearTimeout(timer);
      var title = typeof d.title === "string" ? d.title.trim() : "";
      if (!title) return null;
      return { title: title.slice(0, S.LIMITS.title), channel: typeof d.author_name === "string" ? d.author_name.slice(0, S.LIMITS.channel) : "" };
    }).catch(function () { clearTimeout(timer); return null; });
  }

  function paintStatus(box) {
    box.textContent = "";
    box.className = "add__status";
    if (!addStatus) return;
    box.classList.add("is-" + addStatus.kind);
    box.appendChild(el("span", null, addStatus.msg));
    if (addStatus.editId) {
      var p = S.get(route().id), v = p && p.videos[S.indexOfVideo(p, addStatus.editId)];
      if (v) {
        var b = button("Edit details", { cls: "linkbtn" });
        b.addEventListener("click", function () { openVideoForm(p, v, b); });
        box.appendChild(document.createTextNode(" ")); box.appendChild(b);
      }
    }
  }

  function addForm(p, withCloseHint) {
    var wrap = el("form", "add"); wrap.noValidate = true;
    var label = el("label", "sr", "YouTube link"); label.htmlFor = "add-url";
    var input = el("input"); input.id = "add-url"; input.type = "text"; input.setAttribute("data-add-input", "");
    input.placeholder = "Paste a YouTube link (youtube.com/watch?v=... or youtu.be/...)"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-describedby", "add-status");
    var submit = button("Add", { cls: "btn btn--white", type: "submit" });
    var status = el("p", "add__status"); status.id = "add-status"; status.setAttribute("data-add-status", ""); status.setAttribute("aria-live", "polite");
    var row = el("div", "add__row");
    row.appendChild(label); row.appendChild(input); row.appendChild(submit);
    wrap.appendChild(row); wrap.appendChild(status);
    paintStatus(status);
    input.addEventListener("input", function () { input.removeAttribute("aria-invalid"); });

    wrap.addEventListener("submit", function (e) {
      e.preventDefault();
      var id = u.parseYouTubeId(input.value);
      function fail(msg) { addStatus = { kind: "error", msg: msg }; input.setAttribute("aria-invalid", "true"); paintStatus(status); input.focus(); }
      if (!id) { fail("That does not look like a YouTube link. Try a watch?v= or youtu.be link."); return; }
      var cur = S.get(p.id);
      if (!cur) return;
      var at = S.indexOfVideo(cur, id);
      if (at >= 0) { fail("That video is already in this playlist (number " + (at + 1) + ")."); return; }

      input.disabled = true; submit.disabled = true; submit.lastChild.textContent = "Adding...";
      addStatus = { kind: "ok", msg: "Fetching the title..." }; paintStatus(status);
      fetchMeta(id).then(function (meta) {
        var live = S.get(p.id);
        if (!live) return;
        if (S.indexOfVideo(live, id) >= 0) { input.disabled = false; submit.disabled = false; submit.lastChild.textContent = "Add"; fail("That video is already in this playlist."); return; }
        var title = meta ? meta.title : "YouTube video " + id;
        addStatus = meta ? { kind: "ok", msg: "Added “" + title + "”." }
          : { kind: "warn", msg: "Added as “" + title + "” because the title could not be fetched.", editId: id };
        addOpen = true;
        pendingFocus = "[data-add-input]";
        S.addVideo(p.id, { id: id, title: title, channel: meta ? meta.channel : "", duration: "" });
        announce(addStatus.msg);
      });
    });
    return wrap;
  }

  /* ----- edit video details (title, channel, optional duration) ----- */
  function openVideoForm(p, v, opener) {
    var L = S.LIMITS;
    var d = D.open({ kind: "Edit video", title: "Video details", opener: opener,
      restore: function () { return $('[data-vid="' + v.id + '"] [data-act="edit"]'); } });
    var form = el("form", "form"); form.noValidate = true;
    var t = el("input"); t.id = "v-title"; t.type = "text"; t.maxLength = L.title; t.value = v.title; t.required = true;
    t.setAttribute("aria-describedby", "v-title-err");
    var terr = el("p", "field__err"); terr.id = "v-title-err";
    var c = el("input"); c.id = "v-chan"; c.type = "text"; c.maxLength = L.channel; c.value = v.channel;
    var du = el("input"); du.id = "v-dur"; du.type = "text"; du.value = v.duration; du.placeholder = "e.g. 17:05 or 1:56:20"; du.maxLength = 9;
    du.setAttribute("aria-describedby", "v-dur-err");
    var derr = el("p", "field__err"); derr.id = "v-dur-err";
    t.addEventListener("input", function () { t.removeAttribute("aria-invalid"); terr.textContent = ""; });
    du.addEventListener("input", function () { du.removeAttribute("aria-invalid"); derr.textContent = ""; });

    var tm = el("div", "field__meta"); tm.appendChild(terr);
    var dm = el("div", "field__meta"); dm.appendChild(derr); dm.appendChild(el("span", "muted", "Optional"));
    form.appendChild(field("v-title", "Title", t, tm));
    form.appendChild(field("v-chan", "Channel (optional)", c));
    form.appendChild(field("v-dur", "Duration", du, dm));
    var row = el("div", "modal__row");
    var cancel = button("Cancel", { cls: "btn btn--ghost" }), save = button("Save", { cls: "btn btn--white", type: "submit" });
    cancel.addEventListener("click", d.close);
    row.appendChild(cancel); row.appendChild(save); form.appendChild(row);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!t.value.trim()) { terr.textContent = "A title is required."; t.setAttribute("aria-invalid", "true"); t.focus(); return; }
      var dur = du.value.trim();
      if (dur && u.parseDuration(dur) == null) { derr.textContent = "Use m:ss or h:mm:ss, for example 17:05."; du.setAttribute("aria-invalid", "true"); du.focus(); return; }
      addStatus = null;
      S.updateVideo(p.id, v.id, { title: t.value.trim(), channel: c.value.trim(), duration: dur ? u.normDuration(dur) : "" });
      d.close();
      announce("Video details saved");
    });
    d.body.appendChild(form);
    t.focus(); t.select();
  }

  /* ----- video list (rows, move buttons, drag and drop) ----- */
  function videoList(p) {
    var ol = el("ol", "vlist");
    ol.setAttribute("aria-label", "Videos in " + p.name);
    p.videos.forEach(function (v, i) { ol.appendChild(videoRow(p, v, i)); });
    enableDrag(ol, p);
    return ol;
  }

  function iconBtn(act, iconName, label, fn) {
    var b = button("", { cls: "iconbtn", icon: iconName, aria: label, title: label });
    b.setAttribute("data-act", act);
    b.addEventListener("click", fn);
    return b;
  }

  /** "View notes": opens the split view (notes panel on the right, video list as a left nav). */
  function openNotes(video) {
    if (AQ.split) AQ.split.open(video);
  }

  /** Thin per-video progress bar (only once the video has been started). */
  function videoBar(v) {
    var wi = S.watchInfo(v.id, u.parseDuration(v.duration));
    var track = el("div", "vbar" + (wi.state === "new" ? " vbar--none" : wi.done ? " vbar--done" : ""));
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Watched: " + v.title);
    track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); track.setAttribute("aria-valuenow", String(wi.pct));
    var fill = el("span", "vbar__fill"); fill.style.width = wi.pct + "%";
    track.appendChild(fill);
    return track;
  }

  function videoRow(p, v, i) {
    var last = p.videos.length - 1;
    var li = el("li", "vrow"); li.draggable = true; li.setAttribute("data-vid", v.id);

    var grip = el("span", "vrow__grip"); grip.appendChild(icon("grip")); grip.title = "Drag to reorder";
    li.appendChild(grip);
    li.appendChild(el("span", "vrow__n", String(i + 1)));

    var th = el("button", "vrow__thumb"); th.type = "button";
    th.setAttribute("aria-label", "Watch: " + v.title);
    th.appendChild(u.thumbImg(v.id));
    var pl = el("span", "vrow__play"); pl.appendChild(icon("play")); th.appendChild(pl);
    if (v.duration) th.appendChild(el("span", "vrow__badge", v.duration));
    th.draggable = false;
    th.addEventListener("click", function () { AQ.player.open({ queue: p.videos.slice(), index: i, opener: th, restore: function () { return $('[data-vid="' + v.id + '"] [data-act="watch"]', view); } }); });
    li.appendChild(th);

    var info = el("div", "vrow__info");
    info.appendChild(el("h3", "vrow__title", v.title));
    info.appendChild(videoBar(v));
    info.appendChild(el("p", "vrow__chan muted", v.channel || "Unknown channel"));
    li.appendChild(info);

    li.appendChild(el("span", "vrow__dur", v.duration || "—"));

    var acts = el("div", "vrow__actions");
    var wl = S.watchLabel(v.id);                      // "Play" / "Resume · 12:34" / "Replay"
    var w = button(wl.label, { cls: "btn btn--white btn--sm", icon: wl.icon, aria: wl.label.split(" · ")[0] + " " + v.title + (wl.resumeAt ? " from " + S.clock(wl.resumeAt) : "") });
    w.setAttribute("data-act", "watch");
    w.addEventListener("click", function () { AQ.player.open({ queue: p.videos.slice(), index: i, opener: w, restore: function () { return $('[data-vid="' + v.id + '"] [data-act="watch"]', view); } }); });
    var n = AQ.noteButton ? AQ.noteButton(v, { onView: openNotes }) : null;   // notes open only in the split view
    if (n) n.setAttribute("data-act", "notes");
    var ed = iconBtn("edit", "pencil", "Edit details: " + v.title, function () { openVideoForm(p, v, ed); });
    var up = iconBtn("up", "up", "Move up: " + v.title, function () { moveBy(p, i, -1, "up"); });
    var dn = iconBtn("down", "down", "Move down: " + v.title, function () { moveBy(p, i, 1, "down"); });
    up.disabled = i === 0; dn.disabled = i === last;
    var rm = iconBtn("remove", "trash", "Remove: " + v.title, function () { removeVideo(p, v, i); });
    rm.classList.add("iconbtn--danger");
    [w, n, ed, up, dn, rm].forEach(function (b) { if (b) acts.appendChild(b); });
    li.appendChild(acts);
    return li;
  }

  function moveBy(p, i, delta, role) {
    var v = p.videos[i], to = i + delta;
    if (to < 0 || to >= p.videos.length) return;
    var vid = v.id;
    pendingFocus = function () {
      var row = $('[data-vid="' + vid + '"]', view);
      return row && (row.querySelector('[data-act="' + role + '"]:not([disabled])') || row.querySelector('[data-act="' + (role === "up" ? "down" : "up") + '"]:not([disabled])'));
    };
    S.moveVideo(p.id, i, to);
    announce(v.title + " moved to position " + (to + 1) + " of " + p.videos.length);
  }

  function removeVideo(p, v, i) {
    var pid = p.id;
    pendingFocus = function () {
      var rows = view.querySelectorAll(".vrow");
      var row = rows[Math.min(i, rows.length - 1)];
      return (row && row.querySelector('[data-act="remove"]')) || $("[data-add-input]", view) || $("[data-focus-fallback]");
    };
    S.removeVideo(pid, v.id);
    toast("Removed “" + v.title + "”.", "Undo", function () { S.addVideo(pid, v, i); });
  }

  function enableDrag(ol, p) {
    var dragId = null, ins = null;
    function marks() { Array.prototype.forEach.call(ol.querySelectorAll(".is-drop-before,.is-drop-after,.is-dragging"), function (n) { n.classList.remove("is-drop-before", "is-drop-after", "is-dragging"); }); }
    function finish() { dragId = null; ins = null; marks(); }

    ol.addEventListener("dragstart", function (e) {
      var row = e.target.closest && e.target.closest(".vrow");
      if (!row) return;
      dragId = row.getAttribute("data-vid");
      row.classList.add("is-dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragId); } catch (x) { /* ignore */ } }
    });
    ol.addEventListener("dragover", function (e) {
      if (!dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      var row = e.target.closest && e.target.closest(".vrow");
      Array.prototype.forEach.call(ol.querySelectorAll(".is-drop-before,.is-drop-after"), function (n) { n.classList.remove("is-drop-before", "is-drop-after"); });
      if (!row) return;
      var r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      var idx = Array.prototype.indexOf.call(ol.children, row);
      ins = after ? idx + 1 : idx;
      row.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
    ol.addEventListener("drop", function (e) {
      if (!dragId) return;
      e.preventDefault();
      var cur = S.get(p.id), from = cur ? S.indexOfVideo(cur, dragId) : -1;
      var to = ins == null ? from : (ins > from ? ins - 1 : ins);
      var title = from >= 0 ? cur.videos[from].title : "";
      finish();
      if (from >= 0 && to !== from) { S.moveVideo(p.id, from, to); announce(title + " moved to position " + (to + 1)); }
    });
    ol.addEventListener("dragend", finish);
  }

  /* ---------- 5. router ---------- */
  function route() {
    var m = /^#\/playlist\/([a-z0-9-]{1,48})(?:\/notes\/([A-Za-z0-9_-]{11}))?\/?$/.exec(location.hash || "");
    return m ? { name: "playlist", id: m[1], notes: m[2] || null } : { name: "home" };
  }

  function render() {
    closeMenu(false);
    if (AQ.split) AQ.split.reset();
    var r = route();
    if (r.name === "playlist") {
      var p = S.get(r.id);
      if (p) renderDetail(p); else renderNotFound();
    } else renderHome();
    $("#storage-warning").hidden = S.storageOk();
    if (pendingFocus) {
      var f = pendingFocus; pendingFocus = null;
      var t = typeof f === "function" ? f() : $(f, view);
      if (t && t.focus) t.focus();
    }
  }

  window.addEventListener("hashchange", function () {
    if (AQ.split && AQ.split.owns()) return;   // open/close/switch of the notes panel inside the same playlist (split.js animates it)
    addOpen = false; addStatus = null; pendingFocus = null;
    if (D.isOpen()) D.close();
    render();
    window.scrollTo(0, 0);
    var h = $("[data-focus-fallback]", view); if (h) h.focus({ preventScroll: true });
  });
  S.subscribe(render);
  render();
})();
