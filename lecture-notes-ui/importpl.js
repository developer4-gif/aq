/* AQ Learning - "Import from YouTube" dialog (playlist link -> preview -> new local playlist).

   AQ.importPlaylist.open(opener)         opens the dialog (focus returns to `opener` when it closes)
   AQ.importPlaylist.uniqueName(title)    free playlist name for `title` ("Title", else "Title (2)", "Title (3)"...), <= LIMITS.name
   AQ.importPlaylist.cleanResponse(data)  validates / normalises the notes server's /api/playlist JSON (null when unusable)

   Talks to the notes server: GET http://127.0.0.1:5055/api/playlist?url=<link>
   -> {id, title, channel, count, videos:[{id, title, channel, duration_sec}], truncated, skipped}.
   Imported playlists are local copies (stored via AQ.store.createWithVideos with source {type:"youtube", listId}); nothing syncs back.
   All text is written with textContent / DOM APIs (never innerHTML). */
(function () {
  "use strict";
  var u = AQ.util, S = AQ.store, D = AQ.dialog;
  var el = u.el, button = u.button, icon = u.icon;

  var API = "http://127.0.0.1:5055";
  var OFFLINE_MSG = "Start the notes server (start.ps1)";
  var LIST_RE = /[?&]list=([A-Za-z0-9_-]{10,64})(?:[&#]|$)/;
  var TIMEOUT_MS = 60000;
  var PREVIEW_TILES = 4;
  var MAX_VIDEOS = 500;                        // sanity cap on what a response may contain (server caps at 200)

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /* ---------- pure helpers ---------- */
  /** A free playlist name for `title`, within the name limit: "Title", then "Title (2)", "Title (3)"... */
  function uniqueName(title) {
    var max = S.LIMITS.name;
    var base = String(title || "").replace(/\s+/g, " ").trim() || "YouTube playlist";
    if (base.length > max) base = base.slice(0, max).trim();
    if (!S.nameTaken(base)) return base;
    for (var n = 2; n < 1000; n++) {
      var suffix = " (" + n + ")";
      var cand = base.slice(0, max - suffix.length).trim() + suffix;
      if (!S.nameTaken(cand)) return cand;
    }
    return base.slice(0, max - 6) + " (" + Date.now() % 100000 + ")";
  }

  /** Validate the server response: only well-formed videos survive, durations become "m:ss" / "h:mm:ss". */
  function cleanResponse(d) {
    if (!d || typeof d !== "object" || typeof d.id !== "string" || !/^[A-Za-z0-9_-]{10,64}$/.test(d.id) || !Array.isArray(d.videos)) return null;
    var L = S.LIMITS, seen = {}, videos = [], skipped = typeof d.skipped === "number" ? Math.max(0, d.skipped | 0) : 0;
    d.videos.slice(0, MAX_VIDEOS).forEach(function (v) {
      if (!v || typeof v.id !== "string" || !u.ID_RE.test(v.id) || seen[v.id]) { skipped++; return; }
      seen[v.id] = 1;
      var sec = typeof v.duration_sec === "number" && isFinite(v.duration_sec) && v.duration_sec > 0 && v.duration_sec < 360000 ? Math.floor(v.duration_sec) : 0;
      videos.push({
        id: v.id,
        title: (typeof v.title === "string" ? v.title.trim() : "").slice(0, L.title) || "YouTube video " + v.id,
        channel: (typeof v.channel === "string" ? v.channel.trim() : "").slice(0, L.channel),
        duration: sec ? S.clock(sec) : "",
        sec: sec
      });
    });
    return {
      id: d.id,
      title: (typeof d.title === "string" ? d.title.trim() : "") || "YouTube playlist",
      channel: (typeof d.channel === "string" ? d.channel.trim() : "").slice(0, L.channel),
      videos: videos, skipped: skipped, truncated: !!d.truncated
    };
  }

  function totalText(videos) {
    var sec = 0, unknown = 0;
    videos.forEach(function (v) { if (v.sec) sec += v.sec; else unknown++; });
    return sec ? u.humanDuration(sec) + (unknown ? "+" : "") : "";
  }

  function announce(text) {
    var live = u.$("#live");
    if (!live) return;
    live.textContent = "";
    setTimeout(function () { live.textContent = text; }, 30);
  }

  /* ---------- network ---------- */
  /** Resolves with the parsed JSON; rejects with an Error whose .message is safe to show. */
  function fetchPlaylist(link, signal) {
    var timedOut = false, ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", function () { if (ctl) ctl.abort(); });
    var viaApi = !!(AQ.api && AQ.api.available && AQ.api.available());      // served by aq-api: it proxies the notes server
    var endpoint = viaApi ? AQ.api.base + "/api/v1/import/youtube?url=" : API + "/api/playlist?url=";
    return fetch(endpoint + encodeURIComponent(link), { cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) {
            var msg = body && typeof body.error === "string" && body.error ? body.error
              : res.status === 404 ? "The notes server does not know how to import playlists yet - restart it with start.ps1."
              : "The notes server could not read that playlist (error " + res.status + ").";
            var err = new Error(msg); err.http = res.status; throw err;
          }
          return body;
        });
      })
      .catch(function (e) {
        if (e && e.http) throw e;
        if (timedOut) throw new Error("YouTube took too long to answer. Please try again.");
        if (e && e.name === "AbortError") { var a = new Error("aborted"); a.aborted = true; throw a; }
        throw new Error(OFFLINE_MSG);                      // fetch rejected: server not running / blocked
      })
      .then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------- dialog ---------- */
  function open(opener) {
    var L = S.LIMITS;
    var current = null;             // cleaned preview data once fetched
    var inflight = null;            // AbortController of the running fetch
    var token = 0;                  // ignores answers that arrive after a newer Fetch / close

    var d = D.open({ kind: "Import from YouTube", title: "Import a playlist", opener: opener,
      onClose: function () { token++; if (inflight) inflight.abort(); } });
    var wrap = el("div", "imp");

    /* step 1: link + Fetch */
    var fetchForm = el("form", "form imp__fetch"); fetchForm.noValidate = true;
    var link = el("input"); link.id = "imp-url"; link.type = "text"; link.autocomplete = "off"; link.spellcheck = false;
    link.placeholder = "https://www.youtube.com/playlist?list=..."; link.maxLength = 300;
    link.setAttribute("aria-describedby", "imp-status");
    var fetchBtn = button("Fetch", { cls: "btn btn--white", type: "submit" });
    var urlRow = el("div", "imp__urlrow"); urlRow.appendChild(link); urlRow.appendChild(fetchBtn);
    var f1 = el("div", "field");
    var l1 = el("label", null, "Playlist link"); l1.htmlFor = "imp-url";
    f1.appendChild(l1); f1.appendChild(urlRow);
    var status = el("p", "imp__status"); status.id = "imp-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    status.appendChild(el("span", "muted", "Paste a public or unlisted playlist link. Videos are copied into a new local playlist."));
    fetchForm.appendChild(f1); fetchForm.appendChild(status);
    wrap.appendChild(fetchForm);

    var preview = el("div", "imp__preview"); preview.hidden = true;
    wrap.appendChild(preview);

    function setStatus(kind, msg) {
      status.textContent = ""; status.className = "imp__status" + (kind ? " is-" + kind : "");
      if (kind === "loading") { var sp = el("span", "imp__spin"); sp.setAttribute("aria-hidden", "true"); status.appendChild(sp); }
      status.appendChild(el("span", kind ? null : "muted", msg));
    }
    function setBusy(on) {
      link.disabled = on; fetchBtn.disabled = on;
      fetchBtn.lastChild.textContent = on ? "Fetching..." : (current ? "Fetch again" : "Fetch");
      wrap.setAttribute("aria-busy", on ? "true" : "false");
    }

    link.addEventListener("input", function () { link.removeAttribute("aria-invalid"); });

    fetchForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var raw = link.value.trim();
      function bad(msg) { setStatus("error", msg); link.setAttribute("aria-invalid", "true"); link.focus(); }
      if (!raw) { bad("Paste a YouTube playlist link first."); return; }
      if (!LIST_RE.test(raw)) { bad("That doesn't look like a playlist link. It should contain list=... (for example youtube.com/playlist?list=PL...)."); return; }
      link.removeAttribute("aria-invalid");
      current = null; preview.hidden = true; preview.textContent = "";
      var my = ++token;
      if (inflight) inflight.abort();
      inflight = typeof AbortController === "function" ? new AbortController() : null;
      setBusy(true); setStatus("loading", "Reading the playlist from YouTube...");
      fetchPlaylist(raw, inflight && inflight.signal).then(function (body) {
        if (my !== token) return;
        var data = cleanResponse(body);
        setBusy(false);
        if (!data) { bad("The notes server sent an unexpected answer. Restart it with start.ps1 and try again."); return; }
        current = data;
        showPreview(data);
      }, function (err) {
        if (my !== token || (err && err.aborted)) return;
        setBusy(false);
        bad(err && err.message ? err.message : "Couldn't read that playlist. Please try again.");
      });
    });

    /* step 2: preview + name/description + Import */
    function showPreview(data) {
      var n = data.videos.length;
      preview.textContent = ""; preview.hidden = false;
      setStatus("ok", n ? "Found " + plural(n, "video", "videos") + "." : "That playlist has nothing to import.");
      announce(n ? "Playlist found: " + data.title + ", " + plural(n, "video", "videos") : "That playlist has no importable videos");

      var head = el("div", "imp__head");
      head.appendChild(el("h3", "imp__title", data.title));
      var meta = [];
      if (data.channel) meta.push(data.channel);
      meta.push(plural(n, "video", "videos"));
      var tt = totalText(data.videos); if (tt) meta.push(tt);
      head.appendChild(el("p", "imp__meta muted", meta.join(" · ")));
      preview.appendChild(head);

      if (data.truncated) preview.appendChild(el("p", "imp__note", "This playlist is longer than the import limit, so only the first " + plural(n, "video", "videos") + " will be imported."));
      if (data.skipped) preview.appendChild(el("p", "imp__note imp__note--soft", plural(data.skipped, "private, deleted or duplicate entry", "private, deleted or duplicate entries") + " skipped."));

      if (!n) {
        preview.appendChild(el("p", "imp__empty muted", "Every video in this playlist is private or deleted, or the playlist is empty. Try another link."));
        return;
      }

      var tiles = el("ul", "imp__tiles"); tiles.setAttribute("aria-label", "First videos in the playlist");
      data.videos.slice(0, PREVIEW_TILES).forEach(function (v) {
        var li = el("li", "imp__tile");
        var th = el("span", "imp__thumb"); th.appendChild(u.thumbImg(v.id));
        if (v.duration) th.appendChild(el("span", "vrow__badge", v.duration));
        li.appendChild(th);
        li.appendChild(el("span", "imp__ttitle", v.title));
        tiles.appendChild(li);
      });
      preview.appendChild(tiles);
      if (n > PREVIEW_TILES) preview.appendChild(el("p", "imp__more muted", "+ " + plural(n - PREVIEW_TILES, "more video", "more videos")));

      var form = el("form", "form imp__import"); form.noValidate = true;
      var name = el("input"); name.id = "imp-name"; name.type = "text"; name.maxLength = L.name; name.autocomplete = "off";
      name.value = uniqueName(data.title);
      name.setAttribute("aria-describedby", "imp-name-count imp-name-err");
      var nameCount = el("span", "field__count"); nameCount.id = "imp-name-count";
      var nameErr = el("p", "field__err"); nameErr.id = "imp-name-err";
      var desc = el("textarea"); desc.id = "imp-desc"; desc.rows = 2; desc.maxLength = L.description;
      desc.value = ("Imported from YouTube" + (data.channel ? " · " + data.channel : "")).slice(0, L.description);
      desc.setAttribute("aria-describedby", "imp-desc-count");
      var descCount = el("span", "field__count"); descCount.id = "imp-desc-count";
      function counts() { nameCount.textContent = name.value.length + " / " + L.name; descCount.textContent = desc.value.length + " / " + L.description; }
      name.addEventListener("input", function () { name.removeAttribute("aria-invalid"); nameErr.textContent = ""; counts(); });
      desc.addEventListener("input", counts); counts();

      var nm = el("div", "field__meta"); nm.appendChild(nameErr); nm.appendChild(nameCount);
      var dm = el("div", "field__meta"); dm.appendChild(el("span", "muted", "Optional")); dm.appendChild(descCount);
      [["imp-name", "Playlist name", name, nm], ["imp-desc", "Description", desc, dm]].forEach(function (a) {
        var f = el("div", "field"), lb = el("label", null, a[1]); lb.htmlFor = a[0];
        f.appendChild(lb); f.appendChild(a[2]); f.appendChild(a[3]); form.appendChild(f);
      });
      if (data.id) form.appendChild(el("p", "imp__fine muted", "This is a local copy: videos you add or remove here are not changed on YouTube."));

      var row = el("div", "modal__row");
      var cancel = button("Cancel", { cls: "btn btn--ghost" });
      var go = button("Import " + plural(n, "video", "videos"), { cls: "btn btn--white", type: "submit", icon: "youtube" });
      cancel.addEventListener("click", d.close);
      row.appendChild(cancel); row.appendChild(go); form.appendChild(row);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var nv = name.value.trim(), err = "";
        if (!nv) err = "Give the playlist a name.";
        else if (nv.length > L.name) err = "Use at most " + L.name + " characters.";
        else if (S.nameTaken(nv)) err = "You already have a playlist with this name. Try “" + uniqueName(nv) + "”.";
        if (err) { nameErr.textContent = err; name.setAttribute("aria-invalid", "true"); name.focus(); return; }
        go.disabled = true;
        var res = S.createWithVideos(nv, desc.value, data.videos, { type: "youtube", listId: data.id });
        if (!res) { go.disabled = false; nameErr.textContent = "Couldn't create the playlist. Try a different name."; name.setAttribute("aria-invalid", "true"); name.focus(); return; }
        d.close();
        announce("Imported " + plural(res.added, "video", "videos") + " into " + res.playlist.name);
        location.hash = "#/playlist/" + res.playlist.id;
      });
      preview.appendChild(form);
      name.focus(); name.select();
      try { preview.scrollIntoView({ block: "nearest" }); } catch (e) { /* old browser */ }
    }

    d.body.appendChild(wrap);
    link.focus();
    return d;
  }

  AQ.importPlaylist = { open: open, uniqueName: uniqueName, cleanResponse: cleanResponse };
})();
