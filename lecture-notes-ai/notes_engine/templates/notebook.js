/* Lecture Notes AI - measured pagination. Runs in the browser (preview) and in headless Edge/Chrome (PDF).
   Source units live in #source; pages are generated into #pages. Every page gets a chrome (rings, footer, pg. N / M). */
(function () {
  'use strict';
  var root = document.documentElement;
  var isPrint = root.getAttribute('data-print') === '1';
  var SLACK = 1;                                   // px tolerance when testing overflow
  var pagesEl = document.getElementById('pages');
  var srcEl = document.getElementById('source');
  var ringsHTML = (document.getElementById('rings-tpl') || {}).innerHTML || '';
  var docTitle = root.getAttribute('data-doc-title') || 'notes';

  var pages = [];                                  // {el, content, unit}
  var cur = null;

  function fits(c) { return c.scrollHeight <= c.clientHeight + SLACK; }

  function makePage(kind, unit) {
    var p = document.createElement('div');
    p.className = 'page ' + (kind || '');
    p.innerHTML = ringsHTML;
    var c = document.createElement('div');
    c.className = 'content';
    p.appendChild(c);
    pagesEl.appendChild(p);
    var rec = { el: p, content: c, unit: unit, starts: [] };
    pages.push(rec);
    return rec;
  }

  function contHead(unit) {
    var d = document.createElement('div');
    d.className = 'item cont-head';
    d.setAttribute('data-keep', '1');
    var n = unit.getAttribute('data-num');
    var t = unit.getAttribute('data-title') || '';
    var s = document.createElement('span');
    s.textContent = (n ? n + '. ' : '') + t;
    var em = document.createElement('em');
    em.textContent = '… continued';
    d.appendChild(s); d.appendChild(em);
    if (unit._ul) d.appendChild(unit._ul.cloneNode(true));
    return d;
  }

  function newPageFor(unit) {
    cur = makePage(unit.getAttribute('data-kind'), unit);
    return cur;
  }

  function contentItems(content) { return Array.prototype.slice.call(content.children); }

  // true when the current page holds nothing but keep-with-next headers (so moving the item would gain nothing)
  function pageEffectivelyEmpty(content, except) {
    var kids = contentItems(content);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === except) continue;
      if (kids[i].getAttribute('data-keep') !== '1') return false;
    }
    return true;
  }

  function zoomFit(item, content) {
    var base = parseFloat(item.style.zoom || '1') || 1;
    for (var z = 0.96; z >= 0.4; z -= 0.04) {
      item.style.zoom = (base * z).toFixed(3);
      if (fits(content)) return;
    }
  }

  function trySplit(item, unit) {
    var sb = item.querySelector('.sb');
    if (!sb || item.getAttribute('data-split') !== '1') return false;
    var n = sb.children.length;
    if (n < 2) return false;
    var empty = pageEffectivelyEmpty(cur.content, item);
    var minKeepAttr = parseInt(item.getAttribute('data-minkeep') || '2', 10);
    var minMove = parseInt(item.getAttribute('data-minmove') || '2', 10);
    var minKeep = empty ? 1 : minKeepAttr;
    if (!empty && n < minKeep + minMove) return false;     // too small to split: move whole
    var moved = [];
    while (sb.children.length > minKeep && !fits(cur.content)) {
      moved.unshift(sb.lastElementChild);
      sb.removeChild(sb.lastElementChild);
    }
    if (!fits(cur.content)) {                              // even minimal head does not fit
      moved.forEach(function (k) { sb.appendChild(k); });
      return false;
    }
    if (!moved.length) return true;
    while (moved.length < minMove && sb.children.length > minKeep) {   // avoid widows
      moved.unshift(sb.lastElementChild);
      sb.removeChild(sb.lastElementChild);
    }
    var rest = item.cloneNode(true);
    var rsb = rest.querySelector('.sb');
    rsb.innerHTML = '';
    moved.forEach(function (k) { rsb.appendChild(k); });
    item.classList.add('cut-after');
    rest.classList.add('cut-before');
    newPageFor(unit);
    cur.content.appendChild(contHead(unit));
    place(rest, unit);
    return true;
  }

  function place(item, unit) {
    cur.content.appendChild(item);
    if (fits(cur.content)) return;
    if (item.getAttribute('data-split') === '1' && trySplit(item, unit)) return;
    if (pageEffectivelyEmpty(cur.content, item)) { zoomFit(item, cur.content); return; }
    // move to a fresh page, dragging along keep-with-next headers directly above (no orphan headings)
    cur.content.removeChild(item);
    var carry = [item];
    var kids = contentItems(cur.content);
    while (kids.length > 1 && kids[kids.length - 1].getAttribute('data-keep') === '1') {
      carry.unshift(kids.pop());
      cur.content.removeChild(carry[0]);
    }
    var headMoved = carry[0].className.indexOf('sec-head') >= 0;
    if (headMoved) { var ix = cur.starts.indexOf(unit); if (ix >= 0) cur.starts.splice(ix, 1); }
    newPageFor(unit);
    if (headMoved) cur.starts.push(unit);
    else cur.content.appendChild(contHead(unit));
    carry.forEach(function (el, i) {
      if (i === carry.length - 1) place(el, unit); else cur.content.appendChild(el);
    });
  }

  // Units flow one after another (no forced page break per section); a unit only opens a new page
  // when the previous page is the cover or the unit is marked data-break="1".
  function layoutUnit(u) {
    var work = u;
    var ul0 = work.querySelector('svg.ul');
    work._ul = ul0 ? ul0.cloneNode(true) : null;
    if (!cur || !cur.content || u.getAttribute('data-break') === '1') newPageFor(work);
    cur.starts.push(work);
    var items = Array.prototype.slice.call(work.querySelectorAll(':scope > .item'));
    items.forEach(function (it) { place(it, work); });
  }

  // ---- Rough.js: python computes the layout and emits shape specs; here they are drawn hand-sketched.
  // Runs BEFORE pagination (on the hidden #source, no layout needed) so measured sizes never change: the
  // svg viewBox is fixed and the drawn strokes live inside it. On any failure the plain python strokes
  // (<g class="py">) stay visible.
  var SVGNS = 'http://www.w3.org/2000/svg';
  function drawSpec(rc, s) {
    var a = s.a, o = s.o || {}, node = null;
    switch (s.k) {
      case 'r': node = rc.rectangle(a[0], a[1], a[2], a[3], o); break;
      case 'e': node = rc.ellipse(a[0], a[1], a[2], a[3], o); break;
      case 'l': node = rc.line(a[0], a[1], a[2], a[3], o); break;
      case 'p': node = rc.path(a[0], o); break;
    }
    if (node && s.op) node.setAttribute('opacity', String(s.op));
    return node;
  }
  function roughify(scope) {
    var done = 0, failed = 0;
    if (typeof rough === 'undefined' || !rough.svg) return { done: 0, failed: -1 };
    var svgs = scope.querySelectorAll('svg.d');
    for (var i = 0; i < svgs.length; i++) {
      var svg = svgs[i], rg = svg.querySelector('g.rg'), out = null;
      if (!rg || !rg.children.length) continue;
      try {
        var rc = rough.svg(svg);
        out = document.createElementNS(SVGNS, 'g');
        out.setAttribute('class', 'rough');
        for (var k = 0; k < rg.children.length; k++) {
          var n = drawSpec(rc, JSON.parse(rg.children[k].getAttribute('data-s')));
          if (n) out.appendChild(n);
        }
        svg.insertBefore(out, svg.querySelector('g.tx'));
        svg.removeChild(rg);
        svg.setAttribute('class', svg.getAttribute('class') + ' rough-on');
        done++;
      } catch (e) {
        failed++;
        if (out && out.parentNode) out.parentNode.removeChild(out);
      }
    }
    return { done: done, failed: failed };
  }

  function paginate() {
    try {
      var rs = roughify(srcEl);
      root.setAttribute('data-rough', rs.failed < 0 ? 'missing' : (rs.failed ? 'partial' : String(rs.done)));
    } catch (e) { root.setAttribute('data-rough', 'error'); }
    var kids = Array.prototype.slice.call(srcEl.children);
    kids.forEach(function (u) {
      var kind = u.getAttribute('data-kind');
      if (kind === 'cover') {
        var pg = u.firstElementChild;
        pagesEl.appendChild(pg);
        pages.push({ el: pg, content: null, unit: u });
        return;
      }
      layoutUnit(u);
    });
    finish();
  }

  function finish() {
    var total = pages.length;
    // section number -> page (1-based) where its heading sits; also the page of the first non-section unit after them
    var secFirst = {}, lastNum = 0, afterSections = 0;
    pages.forEach(function (p, i) {
      (p.starts || []).forEach(function (u) {
        var k = u.getAttribute('data-kind');
        var num = parseInt(u.getAttribute('data-num') || '', 10);
        if (k === 'section' && !isNaN(num)) {
          if (!(num in secFirst)) secFirst[num] = i + 1;
          if (num >= lastNum) lastNum = num;
          afterSections = 0;
        } else if (k !== 'cover' && !afterSections) afterSections = i + 1;
      });
    });
    pages.forEach(function (p, i) {
      if (p.content) p.el.setAttribute('data-fill', Math.round((p.content.lastElementChild ? p.content.lastElementChild.getBoundingClientRect().bottom : 0) - p.content.getBoundingClientRect().top) + '/' + p.content.clientHeight);
      var l = document.createElement('div');
      l.className = 'foot-l';
      l.textContent = docTitle + ' — notebook';
      var r = document.createElement('div');
      r.className = 'foot-r';
      r.textContent = 'pg. ' + (i + 1) + ' / ' + total;
      p.el.appendChild(l); p.el.appendChild(r);
      Array.prototype.forEach.call(p.el.querySelectorAll('.nextline'), function (nl) {
        var raw = nl.getAttribute('data-next');
        var m = /^\s*(?:pg\.?|page)\s*(\d+)\s*[:\-–—]?\s*(.*)$/i.exec(raw);
        var target = null, text = raw;
        if (m) {
          var n = parseInt(m[1], 10);
          if (secFirst[n]) target = secFirst[n];
          else if (n === lastNum + 1 && afterSections && afterSections <= total) target = afterSections;
          text = m[2];
        }
        // the next section usually follows right below: a pointer to the same page is just noise
        if (target === i + 1) { nl.parentNode.removeChild(nl); return; }
        nl.textContent = '';
        nl.appendChild(document.createTextNode('next → '));
        if (target) nl.appendChild(document.createTextNode('pg. ' + target + (text ? ': ' : '')));
        nl.appendChild(document.createTextNode(text));
      });
    });
    srcEl.parentNode.removeChild(srcEl);
    root.setAttribute('data-pages', String(total));
    root.setAttribute('data-paginated', '1');
    if (!isPrint) applyZoom();
  }

  function applyZoom() {
    var w = window.innerWidth || 800;
    var z = Math.min(1, (w - 16) / 794);
    pagesEl.style.zoom = z < 1 ? String(z) : '';
  }

  function start() {
    try { paginate(); } catch (e) {
      root.setAttribute('data-error', String(e && e.message || e));
      throw e;
    }
  }

  if (!isPrint) window.addEventListener('resize', function () { if (root.getAttribute('data-paginated')) applyZoom(); });

  var go = function () {
    if (document.fonts && document.fonts.load) {
      var loads = [];
      try { document.fonts.forEach(function (f) { loads.push(f.load().catch(function () {})); }); } catch (e) {}
      Promise.all(loads).then(function () { return document.fonts.ready; }).then(start, start);
    } else { start(); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
