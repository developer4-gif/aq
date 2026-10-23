/* Lecture Notes AI - frontend. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  var POLL_MS = 1200;
  var MAX_POLL_FAILURES = 6;
  var STEPS = ["transcript", "notes", "pdf"];
  var LS_PREFIX = "lna.key.";
  var LS_PROVIDER = "lna.provider";

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    form: $("job-form"), url: $("url"), urlError: $("url-error"),
    provider: $("provider"), providerHint: $("provider-hint"),
    key: $("api-key"), keyNote: $("key-note"), toggleKey: $("toggle-key"), remember: $("remember"),
    model: $("model"), modelHint: $("model-hint"), groqField: $("groq-field"), groqKey: $("groq-key"),
    generate: $("generate"),
    formPanel: $("form-panel"), progressPanel: $("progress-panel"), errorPanel: $("error-panel"), resultPanel: $("result-panel"),
    stepper: $("stepper"), bar: $("bar"), barFill: $("bar-fill"), pct: $("pct"), msg: $("progress-msg"),
    errorMsg: $("error-msg"), retry: $("retry"), edit: $("edit"),
    videoTitle: $("video-title"), videoSub: $("video-sub"), warning: $("warning"),
    dlPdf: $("dl-pdf"), again: $("again"),
    previewWrap: $("preview-wrap"), preview: $("preview"), progressTitle: $("progress-title"),
    resultTitle: $("result-title"), errorTitle: $("error-title"),
    main: $("main"), videoCard: $("video-card"), videoFrame: $("video-frame")
  };

  var providers = [];
  var pollTimer = null;
  var pollFailures = 0;
  var currentJob = null;
  var lastStep = 0;

  /* ---------- safe localStorage ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  /* ---------- helpers ---------- */
  function show(panel) {
    els.main.classList.toggle("has-job", panel !== els.formPanel);
    ["formPanel", "progressPanel", "errorPanel", "resultPanel"].forEach(function (name) {
      els[name].hidden = els[name] !== panel;
    });
  }

  function focusHeading(el) {
    el.setAttribute("tabindex", "-1");
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
  }

  function currentProvider() {
    var id = els.provider.value;
    for (var i = 0; i < providers.length; i++) if (providers[i].id === id) return providers[i];
    return null;
  }

  function apiError(res, body) {
    if (body && typeof body.error === "string" && body.error) return body.error;
    if (res.status === 429) return "The server is busy - please wait a moment and try again.";
    if (res.status === 413) return "That request was too large.";
    return "The server returned an error (" + res.status + ").";
  }

  /* ---------- providers & key handling ---------- */
  function updateProviderUI() {
    var p = currentProvider();
    if (!p) { els.providerHint.textContent = ""; return; }
    els.providerHint.textContent = p.key_hint || "";
    els.model.placeholder = p.default_model ? "default: " + p.default_model : "leave empty for the default";
    els.modelHint.textContent = "";

    // saved key for this provider (if the user opted in earlier)
    var saved = lsGet(LS_PREFIX + p.id);
    els.key.value = saved || "";
    els.remember.checked = !!saved;

    // server-side key note
    if (p.server_key) {
      showKeyNote("Key found on server - you can leave this empty.", false);
      els.key.placeholder = "optional (a key is set on the server)";
    } else {
      showKeyNote("", false);
      els.key.placeholder = "paste your key here";
    }
    // The Whisper-fallback key is redundant when the main provider is Groq
    els.groqField.hidden = p.id === "groq";
    clearFieldError();
  }

  function loadProviders() {
    return fetch("/api/providers", { headers: { "Accept": "application/json" } })
      .then(function (res) { return res.json().then(function (b) { return { res: res, body: b }; }); })
      .then(function (r) {
        if (!r.res.ok || !r.body || !Array.isArray(r.body.providers)) throw new Error("bad providers response");
        providers = r.body.providers;
        els.provider.textContent = "";
        providers.forEach(function (p) {
          var o = document.createElement("option");
          o.value = p.id;
          o.textContent = p.label + (p.server_key ? " (key on server)" : "");
          els.provider.appendChild(o);
        });
        var last = lsGet(LS_PROVIDER);
        if (last && providers.some(function (p) { return p.id === last; })) els.provider.value = last;
        updateProviderUI();
      })
      .catch(function () {
        els.provider.textContent = "";
        var o = document.createElement("option");
        o.value = "";
        o.textContent = "Could not load providers - is the server running?";
        els.provider.appendChild(o);
        els.generate.disabled = true;
      });
  }

  /* ---------- validation ---------- */
  function clearFieldError() {
    els.urlError.hidden = true;
    els.urlError.textContent = "";
    els.url.removeAttribute("aria-invalid");
    els.url.removeAttribute("aria-describedby");
  }

  function fieldError(msg) {
    els.urlError.textContent = msg;
    els.urlError.hidden = false;
    els.url.setAttribute("aria-invalid", "true");
    els.url.setAttribute("aria-describedby", "url-error");
    els.url.focus();
  }

  // Mirrors backend ingest.parse_video_id: only real YouTube hosts, strict 11-char id.
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var YT_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
                  "youtube-nocookie.com", "www.youtube-nocookie.com"];
  var SHORT_HOSTS = ["youtu.be", "www.youtu.be"];
  var PATH_PREFIXES = ["shorts", "embed", "live", "v", "e"];

  function parseVideoId(raw) {
    raw = String(raw || "").trim();
    if (!raw || raw.length > 2048 || /[\r\n\t\0]/.test(raw)) return null;
    if (ID_RE.test(raw)) return raw;
    if (raw.indexOf("://") === -1) raw = "https://" + raw.replace(/^\/+/, "");
    var u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.port && u.port !== "80" && u.port !== "443") return null;
    var host = u.hostname.toLowerCase().replace(/\.$/, "");
    var segs = u.pathname.split("/").filter(Boolean);
    var cand = null;
    if (SHORT_HOSTS.indexOf(host) !== -1) {
      cand = segs[0] || null;
    } else if (YT_HOSTS.indexOf(host) !== -1) {
      if (segs[0] === "watch") cand = u.searchParams.get("v");
      else if (segs.length >= 2 && PATH_PREFIXES.indexOf(segs[0]) !== -1) cand = segs[1];
    } else {
      return null;
    }
    return cand && ID_RE.test(cand) ? cand : null;
  }

  /* ---------- embedded player ---------- */
  var shownVideoId = null;

  function updateVideo() {
    var id = parseVideoId(els.url.value);
    if (id === shownVideoId) return;
    shownVideoId = id;
    els.videoFrame.textContent = "";
    if (!id) { els.videoCard.hidden = true; return; }
    var f = document.createElement("iframe");
    // src is built ONLY from the validated 11-character id, never from the raw input
    f.src = "https://www.youtube-nocookie.com/embed/" + id;
    f.title = "YouTube video player";
    f.setAttribute("allow", "accelerometer; encrypted-media; picture-in-picture; fullscreen");
    f.setAttribute("allowfullscreen", "");
    f.setAttribute("loading", "lazy");
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    els.videoFrame.appendChild(f);
    els.videoCard.hidden = false;
  }

  var videoTimer = null;
  function scheduleVideoUpdate() {
    if (videoTimer) clearTimeout(videoTimer);
    videoTimer = setTimeout(updateVideo, 250);
  }

  /* ---------- progress UI ---------- */
  function setProgress(pct, message, stage, failed) {
    pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
    els.barFill.style.width = pct + "%";
    els.bar.setAttribute("aria-valuenow", String(pct));
    els.pct.textContent = pct + "%";
    if (message) els.msg.textContent = message;

    var idx = STEPS.indexOf(stage);
    if (idx < 0) idx = lastStep;
    lastStep = Math.max(lastStep, idx);
    var items = els.stepper.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      var cls = "";
      if (pct >= 100 && !failed) cls = "done";
      else if (i < lastStep) cls = "done";
      else if (i === lastStep) cls = failed ? "failed" : "active";
      items[i].className = cls;
      if (cls === "active") items[i].setAttribute("aria-current", "step"); else items[i].removeAttribute("aria-current");
    }
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function poll() {
    if (!currentJob) return;
    var jobId = currentJob;
    fetch("/api/jobs/" + encodeURIComponent(jobId), { headers: { "Accept": "application/json" }, cache: "no-store" })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (b) { return { res: res, body: b }; });
      })
      .then(function (r) {
        if (jobId !== currentJob) return; // superseded
        if (r.res.status === 404) {
          return fail("This job was lost (the server may have been restarted). Please start again.");
        }
        if (!r.res.ok || !r.body) throw new Error("bad status");
        pollFailures = 0;
        var d = r.body;
        if (d.status === "error") {
          setProgress(d.pct, null, d.stage, true);
          return fail(d.error || "Something went wrong. Please try again.");
        }
        setProgress(d.pct, d.message, d.stage, false);
        if (d.status === "done") return finish(d);
        pollTimer = setTimeout(poll, POLL_MS);
      })
      .catch(function () {
        if (jobId !== currentJob) return;
        pollFailures += 1;
        if (pollFailures >= MAX_POLL_FAILURES) {
          return fail("Lost connection to the server. Make sure it is still running, then try again.");
        }
        els.msg.textContent = "Reconnecting...";
        pollTimer = setTimeout(poll, POLL_MS * 2);
      });
  }

  function fail(message) {
    stopPolling();
    currentJob = null;
    els.generate.disabled = false;
    els.errorMsg.textContent = message;
    show(els.errorPanel);
    focusHeading(els.errorTitle);
  }

  function finish(d) {
    stopPolling();
    currentJob = null;
    els.generate.disabled = false;
    var meta = d.meta || {};
    var links = d.links || {};
    els.videoTitle.textContent = meta.title || "Your lecture";
    var bits = [];
    if (meta.channel) bits.push(meta.channel);
    if (meta.duration) bits.push(meta.duration);
    els.videoSub.textContent = bits.join(" · ");

    if (d.warning) { els.warning.textContent = d.warning; els.warning.hidden = false; }
    else { els.warning.hidden = true; els.warning.textContent = ""; }

    setLink(els.dlPdf, links.pdf);
    if (links.html) {
      els.previewWrap.classList.remove("empty");
      els.preview.src = links.html;
    } else {
      els.previewWrap.classList.add("empty");
      els.preview.removeAttribute("src");
    }
    show(els.resultPanel);
    focusHeading(els.resultTitle);
  }

  function setLink(a, href) {
    if (href) { a.href = href; a.hidden = false; }
    else { a.removeAttribute("href"); a.hidden = true; }
  }

  /* ---------- submit ---------- */
  function submit() {
    clearFieldError();
    var url = els.url.value.trim();
    if (!url) return fieldError("Please paste a YouTube link.");
    if (!parseVideoId(url)) return fieldError("That doesn't look like a YouTube video link (youtube.com or youtu.be, with an 11-character video id).");

    var p = currentProvider();
    if (!p) return fieldError("Choose an AI provider first.");

    var key = els.key.value.trim();
    if (!key && !p.server_key) {
      showKeyNote("Please paste your " + p.label + " API key (or set it in backend/.env).", true);
      els.key.focus();
      return;
    }

    // remember (or forget) the key for this provider only if the user opted in
    lsSet(LS_PROVIDER, p.id);
    if (els.remember.checked && key) lsSet(LS_PREFIX + p.id, key); else lsDel(LS_PREFIX + p.id);

    var body = { url: url, provider: p.id };
    if (key) body.api_key = key;
    var model = els.model.value.trim();
    if (model) body.model = model;
    var gk = els.groqKey.value.trim();
    if (gk && p.id !== "groq") body.groq_key = gk;

    els.generate.disabled = true;
    lastStep = 0;
    pollFailures = 0;
    setProgress(0, "Starting...", "transcript", false);
    show(els.progressPanel);
    focusHeading(els.progressTitle);

    fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (b) { return { res: res, body: b }; });
      })
      .then(function (r) {
        if (!r.res.ok || !r.body || !r.body.job_id) return fail(apiError(r.res, r.body));
        currentJob = r.body.job_id;
        poll();
      })
      .catch(function () {
        fail("Could not reach the server. Make sure Lecture Notes AI is running (python run.py).");
      });
  }

  function showKeyNote(text, isError) {
    els.keyNote.textContent = text;
    els.keyNote.classList.toggle("is-error", !!isError);
  }

  /* ---------- wire up ---------- */
  els.form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  els.provider.addEventListener("change", function () { updateProviderUI(); });
  els.key.addEventListener("input", function () { els.keyNote.classList.remove("is-error"); });
  els.url.addEventListener("input", function () { clearFieldError(); scheduleVideoUpdate(); });
  els.url.addEventListener("change", updateVideo);

  els.toggleKey.addEventListener("click", function () {
    var showing = els.key.type === "text";
    els.key.type = showing ? "password" : "text";
    els.toggleKey.textContent = showing ? "Show" : "Hide";
    els.toggleKey.setAttribute("aria-pressed", showing ? "false" : "true");
  });

  els.remember.addEventListener("change", function () {
    var p = currentProvider();
    if (p && !els.remember.checked) lsDel(LS_PREFIX + p.id); // unticking forgets immediately
  });

  els.retry.addEventListener("click", submit);
  els.edit.addEventListener("click", function () {
    show(els.formPanel);
    els.url.focus();
  });
  els.again.addEventListener("click", function () {
    els.preview.removeAttribute("src");
    els.url.value = "";
    updateVideo();
    show(els.formPanel);
    els.url.focus();
    window.scrollTo(0, 0);
  });

  show(els.formPanel);
  updateVideo();
  loadProviders();
})();
