/* AQ Learning - shared helpers (DOM builders, icons, YouTube id parsing, time formatting).
   Everything hangs off the single global `AQ` namespace: AQ.util, AQ.store, AQ.dialog, AQ.notes, AQ.player. */
window.AQ = window.AQ || {};
(function () {
  "use strict";

  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function $(sel, root) { return (root || document).querySelector(sel); }

  /** Create an element. Text is ALWAYS set with textContent (never innerHTML). */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- icons (stroke icons drawn with DOM APIs) ---------- */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICONS = {
    play:     { d: "M8 5v14l11-7z", fill: true },
    dots:     { d: "M5 12h.01M12 12h.01M19 12h.01", thick: true },
    plus:     { d: "M12 5v14M5 12h14" },
    back:     { d: "M19 12H5M12 19l-7-7 7-7" },
    up:       { d: "M6 15l6-6 6 6" },
    down:     { d: "M6 9l6 6 6-6" },
    grip:     { d: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01", thick: true },
    trash:    { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" },
    pencil:   { d: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" },
    notes:    { d: "M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 13h8M8 17h6" },
    external: { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" },
    search:   { d: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3" },
    user:     { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z" },
    youtube:  { d: "M3 8a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H6a3 3 0 01-3-3zM10 9.5v5l4.5-2.5z" },
    list:     { d:"M3 6h13M3 12h13M3 18h6M15 15v6l5-3z" },
    prev:     { d: "M19 4L9 12l10 8zM5 5v14" },
    next:     { d: "M5 4l10 8-10 8zM19 5v14" }
  };
  function icon(name) {
    var spec = ICONS[name] || ICONS.play;
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.setAttribute("class", "icon");
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", spec.d);
    if (spec.fill) { p.setAttribute("fill", "currentColor"); }
    else {
      p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", spec.thick ? "3" : "2");
      p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    }
    s.appendChild(p);
    return s;
  }

  /** Button builder: button(label, {cls, icon, type, aria}) */
  function button(label, opts) {
    opts = opts || {};
    var b = el("button", opts.cls || "btn");
    b.type = opts.type || "button";
    if (opts.icon) b.appendChild(icon(opts.icon));
    if (label) b.appendChild(el("span", null, label));
    if (opts.aria) b.setAttribute("aria-label", opts.aria);
    if (opts.title) b.title = opts.title;
    return b;
  }

  /* ---------- YouTube ---------- */
  /** Extract a validated 11-char YouTube id from a URL or bare id; null if invalid. */
  function parseYouTubeId(input) {
    var s = String(input || "").trim();
    if (!s) return null;
    if (ID_RE.test(s)) return s;
    var u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return null; }
    var host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    var id = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        var m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    return id && ID_RE.test(id) ? id : null;
  }
  function watchUrl(id) { return "https://www.youtube.com/watch?v=" + id; }
  function thumbUrl(id) { return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"; }

  /** <img> for a video thumbnail; hides itself if the image fails. */
  function thumbImg(id) {
    var img = el("img");
    img.src = thumbUrl(id); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.addEventListener("error", function () { img.style.visibility = "hidden"; });
    return img;
  }

  /* ---------- durations ---------- */
  var DUR_RE = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/;
  /** "1:56:20" / "17:05" -> seconds, or null when not a valid duration. */
  function parseDuration(s) {
    var m = DUR_RE.exec(String(s || "").trim());
    if (!m) return null;
    return (m[1] ? +m[1] : 0) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  /** Normalise user input to "m:ss" or "h:mm:ss"; "" if invalid/empty. */
  function normDuration(s) {
    var sec = parseDuration(s);
    if (sec == null) return "";
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return h ? h + ":" + pad(m) + ":" + pad(x) : m + ":" + pad(x);
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  /** Seconds -> "45 min" / "2 hr 43 min". */
  function humanDuration(sec) {
    var m = Math.round(sec / 60);
    if (m < 1) return "1 min";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return h + " hr" + (r ? " " + r + " min" : "");
  }

  /** {count, seconds, unknown} for a playlist */
  function stats(p) {
    var sec = 0, unknown = 0;
    p.videos.forEach(function (v) { var s = parseDuration(v.duration); if (s == null) unknown++; else sec += s; });
    return { count: p.videos.length, seconds: sec, unknown: unknown };
  }
  /** "3 videos · 1 hr 12 min" (a trailing "+" when some durations are unknown). */
  function statsText(p) {
    var st = stats(p);
    var t = st.count + (st.count === 1 ? " video" : " videos");
    if (st.seconds > 0) t += " · " + humanDuration(st.seconds) + (st.unknown ? "+" : "");
    return t;
  }

  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) { var h = Math.floor(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
    if (s < 86400 * 30) { var d = Math.floor(s / 86400); return d + (d === 1 ? " day ago" : " days ago"); }
    try { return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return new Date(t).toDateString(); }
  }

  AQ.util = {
    $: $, el: el, icon: icon, button: button,
    ID_RE: ID_RE, parseYouTubeId: parseYouTubeId, watchUrl: watchUrl, thumbUrl: thumbUrl, thumbImg: thumbImg,
    parseDuration: parseDuration, normDuration: normDuration, humanDuration: humanDuration,
    stats: stats, statsText: statsText, timeAgo: timeAgo
  };
})();
