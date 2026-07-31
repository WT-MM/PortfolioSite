// Paint mode: repaint the page, live, with a genetic algorithm running
// in Web Workers (genetic-paint-worker.js, a port of
// github.com/WT-MM/GeneticPainting).
// - Images are repainted in place (data-paint-focus="x,y,r" pins the
//   refinement mask, data-paint-mode="text" forces ink mode).
// - Text blocks (nav and footer included) are rasterized via an
//   inline-styled SVG foreignObject and painted in ink mode; the real
//   text sits transparent on top so links/selection keep working.
// - Same-origin PDF iframes (resume) are replaced with pdf.js-rendered
//   pages, each painted in ink mode.
// - Work is scheduled viewport-first and re-prioritized on scroll;
//   frames are double-buffered (decode before swap) to avoid flicker.
// - ?paint=1 forces paint mode on (used for automated screenshots).
(function () {
  var KEY = "paintMode";
  var WORKER_URL = "/assets/js/genetic-paint-worker.js";
  var PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var MAX_DIM = 640;
  var MIN_DIM = 40;
  var TEXT_SCALE = 1.5;
  var BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,td,th,figcaption,a";
  var POOL = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

  var style = document.createElement("style");
  style.textContent =
    "#paint-toggle{cursor:pointer;user-select:none;position:relative;" +
    "display:inline-flex;align-items:center;transition:opacity .2s ease}" +
    "#paint-toggle:not(.active){opacity:.55}" +
    "#paint-toggle:hover{opacity:1}" +
    "#paint-toggle.active{opacity:1}" +
    "#paint-toggle.active .paint-toggle-blob{fill:currentColor}" +
    "#paint-toggle::after{content:attr(data-label);position:absolute;" +
    "top:100%;right:0;white-space:nowrap;background:#212529;color:#f8f9fa;" +
    "font-size:12px;font-family:inherit;padding:3px 8px;border-radius:4px;" +
    "opacity:0;pointer-events:none;transform:translateY(-4px);" +
    "transition:opacity .2s ease,transform .2s ease}" +
    "#paint-toggle:hover::after{opacity:1;transform:translateY(2px)}" +
    ".paint-block,.paint-block *{color:transparent!important;" +
    "-webkit-text-fill-color:transparent!important;text-shadow:none!important}" +
    // the painted raster depicts descendant backgrounds already (e.g. an
    // active TOC highlight) — they must not draw over the painted ink
    ".paint-block *{background-color:transparent!important;" +
    "background-image:none!important}" +
    ".paint-pdf-pages img{display:block;width:100%;max-width:900px;" +
    "margin:0 auto 12px;border:1px solid #ddd;background:#fff}";
  document.head.appendChild(style);

  var on = false;
  var queue = [];
  var workers = [];
  var jobs = {};
  var nextId = 1;

  // Painted blocks whose size later changes (collapsible TOC sections,
  // accordions) would show their ink stretched over the new box —
  // un-paint them and let the real content show.
  function restoreBlock(el, markSkip) {
    var bg = el.style.backgroundImage;
    if (bg && bg.indexOf("blob:") >= 0) URL.revokeObjectURL(bg.slice(5, -2));
    el.classList.remove("paint-block");
    el.style.backgroundImage = "";
    el.style.backgroundSize = "";
    el.style.backgroundRepeat = "";
    delete el.dataset.painting;
    if (markSkip) el.dataset.paintSkip = "1"; // dynamic element: leave it real
  }

  var resizeWatch = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
          var el = entry.target;
          if (!el.dataset.painting) { resizeWatch.unobserve(el); return; }
          var w0 = +el.dataset.paintW, h0 = +el.dataset.paintH;
          // compare on the same box model as the stored baseline —
          // contentRect excludes padding and false-triggers
          var r = el.getBoundingClientRect();
          if (w0 && h0 && (Math.abs(r.width - w0) / w0 > 0.2 ||
                           Math.abs(r.height - h0) / h0 > 0.2)) {
            resizeWatch.unobserve(el);
            var redraws = (+el.dataset.paintRedraws || 0) + 1;
            el.dataset.paintRedraws = redraws;
            // a block that keeps resizing shouldn't thrash — leave it real
            restoreBlock(el, redraws > 4);
            if (redraws <= 4) {
              // repaint at the new size once the layout settles
              setTimeout(function () {
                if (on && el.isConnected && !el.dataset.painting &&
                    !el.dataset.paintSkip) {
                  queue.push({ kind: "block", el: el });
                  workers.forEach(function (w) { if (!w.busy) pump(w); });
                }
              }, 500);
            }
          }
        });
      })
    : null;

  // ------------------------------------------------------------- helpers

  function nearViewport(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > -innerHeight * 0.5 && r.top < innerHeight * 1.5;
  }

  function byViewport(a, b) {
    var ra = a.el.getBoundingClientRect(), rb = b.el.getBoundingClientRect();
    var va = ra.bottom > 0 && ra.top < innerHeight ? 0 : 1;
    var vb = rb.bottom > 0 && rb.top < innerHeight ? 0 : 1;
    return va - vb || ra.top - rb.top;
  }

  function pageBackground(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      var bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      node = node.parentElement;
    }
    return "rgb(255, 255, 255)";
  }

  function cssColorToRgb(css) {
    var m = css.match(/(\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255];
  }

  // ------------------------------------------------------------- images

  function eligibleImg(img) {
    if (!img.complete || !img.naturalWidth) return false;
    if (img.naturalWidth < MIN_DIM || img.naturalHeight < MIN_DIM) return false;
    var src = img.currentSrc || img.src;
    if (src.indexOf("data:") === 0) return true;
    return new URL(src, location.origin).origin === location.origin;
  }

  function parseFocus(img) {
    if (!img.dataset.paintFocus) return null;
    var p = img.dataset.paintFocus.split(",").map(parseFloat);
    if (p.length !== 3 || p.some(isNaN)) return null;
    return { x: p[0], y: p[1], r: p[2] };
  }

  function startImgJob(worker, img) {
    // ink-mode images (PDF pages) need finer glyph pixels
    var cap = img.dataset.paintMode === "text" ? 1024 : MAX_DIM;
    var scale = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var buf = document.createElement("canvas");
    buf.width = w; buf.height = h;
    var ctx = buf.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    var pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h);
    } catch (err) {
      return false;
    }
    if (!img.dataset.origSrc) img.dataset.origSrc = img.getAttribute("src");
    var picture = img.closest("picture");
    if (picture) {
      picture.querySelectorAll("source").forEach(function (s) {
        if (s.srcset) { s.dataset.srcset = s.srcset; s.removeAttribute("srcset"); }
      });
    }
    img.dataset.painting = "1";
    var id = nextId++;
    var textMode = img.dataset.paintMode === "text";
    jobs[id] = { kind: "img", el: img, buf: buf, ctx: ctx, url: null,
                 png: textMode, worker: worker };
    worker.busy = id;
    worker.postMessage(
      { cmd: "paint", id: id, width: w, height: h, data: pixels.data.buffer,
        seed: id * 1299721, focus: parseFocus(img),
        mode: textMode ? "text" : null,
        bg: textMode ? [255, 255, 255] : null,
        // document pages carry far more ink than a paragraph
        inkCap: textMode ? 20000 : null },
      [pixels.data.buffer]
    );
    return true;
  }

  // ------------------------------------------------------------- blocks

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }

  function collectBlocks() {
    var toggle = document.getElementById("paint-toggle");
    var all = Array.prototype.slice.call(document.querySelectorAll(BLOCK_SELECTOR));
    // leaf divs that directly hold text (e.g. the footer contact line)
    Array.prototype.forEach.call(document.querySelectorAll("div"), function (d) {
      if (hasDirectText(d)) all.push(d);
    });
    return all.filter(function (el) {
      if (toggle && el.contains(toggle)) return false;
      if (el.querySelector("img,canvas,iframe,svg")) return false;
      if (el.parentElement &&
          (el.parentElement.closest(BLOCK_SELECTOR) ||
           el.parentElement.closest("[data-painting]"))) return false;
      if (el.dataset.paintSkip) return false;
      var r = el.getBoundingClientRect();
      return r.width >= 40 && r.height >= 14 && r.width * r.height < 700000 &&
        (el.textContent || "").trim().length > 0;
    }).filter(function (el, i, chosen) {
      // never paint a block nested inside another painted block — the
      // outer raster already depicts it, and the descendant-background
      // suppression would blank the inner one (footer email link)
      for (var p = el.parentElement; p; p = p.parentElement)
        if (chosen.indexOf(p) >= 0) return false;
      return true;
    });
  }

  // ------------------------------------------------------------- icons

  function collectIcons() {
    return Array.prototype.filter.call(
      document.querySelectorAll("svg"),
      function (svg) {
        if (svg.closest("#paint-toggle")) return false;
        if (svg.closest("[data-painting]") || svg.dataset.painting) return false;
        var r = svg.getBoundingClientRect();
        return r.width >= 16 && r.width <= 120 && r.height >= 16 && r.height <= 120;
      }
    );
  }

  function startIconJob(worker, svg) {
    var rect = svg.getBoundingClientRect();
    var w = Math.ceil(rect.width), h = Math.ceil(rect.height);
    if (!w || !h) return false;
    var clone = svg.cloneNode(true);
    var cs = getComputedStyle(svg);
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.style.fill = cs.fill;
    var image = new Image();
    var id = nextId++;
    image.onload = function () {
      var S = 3; // paint icons at 3x for finer strokes
      var buf = document.createElement("canvas");
      buf.width = w * S; buf.height = h * S;
      var ctx = buf.getContext("2d");
      var bgCss = pageBackground(svg);
      ctx.fillStyle = bgCss;
      ctx.fillRect(0, 0, buf.width, buf.height);
      ctx.drawImage(image, 0, 0, buf.width, buf.height);
      var pixels;
      try {
        pixels = ctx.getImageData(0, 0, buf.width, buf.height);
      } catch (err) {
        pump(worker);
        return;
      }
      var stand = document.createElement("img");
      stand.className = "paint-icon";
      stand.style.width = w + "px";
      stand.style.height = h + "px";
      stand.style.cursor = "pointer";
      if (svg.getAttribute("onclick"))
        stand.setAttribute("onclick", svg.getAttribute("onclick"));
      stand.src = buf.toDataURL("image/png");
      svg.dataset.painting = "1";
      svg.insertAdjacentElement("afterend", stand);
      svg.style.display = "none";
      jobs[id] = { kind: "img", el: stand, buf: buf, ctx: ctx, url: null,
                   png: true, worker: worker, sourceSvg: svg };
      stand.dataset.painting = "1";
      worker.postMessage(
        { cmd: "paint", id: id, width: buf.width, height: buf.height,
          data: pixels.data.buffer, seed: id * 1299721,
          mode: "text", bg: cssColorToRgb(bgCss),
          inkCap: 700 }, // icons read better sketchy
        [pixels.data.buffer]
      );
    };
    image.onerror = function () { pump(worker); };
    worker.busy = id;
    image.src = "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(clone));
    return true;
  }

  // The raster runs inside an SVG image, which cannot load external
  // fonts — fallback metrics wrap/clip text. Embed the site's webfonts
  // as data URIs once and inject them into every raster.
  var fontCssPromise = null;
  function fontCss() {
    if (fontCssPromise) return fontCssPromise;
    fontCssPromise = (async function () {
      try {
        var css = "";
        var links = Array.prototype.filter.call(
          document.querySelectorAll("link[rel=stylesheet]"),
          function (l) { return /fonts\.googleapis/.test(l.href); }
        );
        for (var i = 0; i < links.length; i++) {
          var text = await (await fetch(links[i].href)).text();
          var urls = text.match(/https:\/\/[^)\s'"]+\.woff2?/g) || [];
          for (var j = 0; j < urls.length; j++) {
            var buf = await (await fetch(urls[j])).arrayBuffer();
            var bytes = new Uint8Array(buf), bin = "";
            for (var k = 0; k < bytes.length; k += 8192)
              bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
            text = text.split(urls[j]).join("data:font/woff2;base64," + btoa(bin));
          }
          css += text;
        }
        return css.replace(/&/g, "&amp;");
      } catch (err) {
        console.warn("paint-mode: font embedding failed", err);
        return "";
      }
    })();
    return fontCssPromise;
  }

  function inlineStyles(src, dst) {
    // Full-fidelity: copy every computed property. A fixed list missed
    // whichever mechanism hid collapsed TOC sub-lists (max-height,
    // visibility, ...), so hidden content leaked into rasters.
    var cs = getComputedStyle(src);
    var out = "";
    for (var i = 0; i < cs.length; i++) {
      var prop = cs[i];
      out += prop + ":" + cs.getPropertyValue(prop) + ";";
    }
    dst.setAttribute("style", out);
    // walk backwards so removals don't shift indices
    for (var c = src.children.length - 1; c >= 0; c--) {
      var child = src.children[c], dchild = dst.children[c];
      if (!dchild) continue;
      // prune subtrees that aren't actually rendered (collapsed lists)
      if (child.getClientRects().length === 0) dchild.remove();
      else inlineStyles(child, dchild);
    }
  }

  function startBlockJob(worker, el) {
    var rect = el.getBoundingClientRect();
    var w = Math.ceil(rect.width), h = Math.ceil(rect.height);
    if (!w || !h) return false;
    var clone = el.cloneNode(true);
    inlineStyles(el, clone);
    clone.style.margin = "0";
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.overflow = "hidden";
    // the clone renders in its own tiny document — absolute/fixed
    // positioning from the live page would displace it out of frame
    clone.style.position = "static";
    clone.style.top = clone.style.left = "auto";
    clone.style.right = clone.style.bottom = "auto";
    clone.style.transform = "none";
    var image = new Image();
    var id = nextId++;
    worker.busy = id;
    image.onload = function () {
      var bw = Math.round(w * TEXT_SCALE), bh = Math.round(h * TEXT_SCALE);
      var buf = document.createElement("canvas");
      buf.width = bw; buf.height = bh;
      var ctx = buf.getContext("2d");
      // paint relative to the element's own background when it has one
      // (e.g. an active TOC highlight), so the box itself isn't "ink"
      var ownBg = getComputedStyle(el).backgroundColor;
      var bgCss = ownBg && ownBg !== "rgba(0, 0, 0, 0)" && ownBg !== "transparent"
        ? ownBg : pageBackground(el);
      ctx.fillStyle = bgCss;
      ctx.fillRect(0, 0, bw, bh);
      ctx.drawImage(image, 0, 0, bw, bh);
      var pixels;
      try {
        pixels = ctx.getImageData(0, 0, bw, bh);
      } catch (err) {
        pump(worker);
        return;
      }
      el.dataset.painting = "1";
      el.dataset.paintW = rect.width;
      el.dataset.paintH = rect.height;
      el.classList.add("paint-block");
      if (resizeWatch) resizeWatch.observe(el);
      jobs[id] = { kind: "block", el: el, buf: buf, ctx: ctx, url: null,
                   png: true, worker: worker };
      worker.postMessage(
        { cmd: "paint", id: id, width: bw, height: bh, data: pixels.data.buffer,
          seed: id * 1299721, mode: "text", bg: cssColorToRgb(bgCss) },
        [pixels.data.buffer]
      );
    };
    image.onerror = function () { pump(worker); };
    fontCss().then(function (fc) {
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<foreignObject width="100%" height="100%">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">' +
        (fc ? "<style>" + fc + "</style>" : "") +
        new XMLSerializer().serializeToString(clone) +
        "</div></foreignObject></svg>";
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    return true;
  }

  // ------------------------------------------------------------- pdfs

  var pdfjsPromise = null;
  function loadPdfjs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = PDFJS_URL;
      s.onload = function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(window.pdfjsLib);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  function expandPdfFrames() {
    var frames = Array.prototype.filter.call(
      document.querySelectorAll("iframe[src$='.pdf']"),
      function (f) {
        return new URL(f.src, location.origin).origin === location.origin &&
          !f.dataset.paintExpanded;
      }
    );
    if (!frames.length) return;
    loadPdfjs().then(function (pdfjs) {
      frames.forEach(function (frame) {
        frame.dataset.paintExpanded = "1";
        var holder = document.createElement("div");
        holder.className = "paint-pdf-pages";
        frame.insertAdjacentElement("afterend", holder);
        pdfjs.getDocument(frame.src).promise.then(function (doc) {
          var width = Math.min(900, frame.getBoundingClientRect().width || 900);
          var renderPage = function (num) {
            if (num > doc.numPages) return;
            doc.getPage(num).then(function (page) {
              var vp = page.getViewport({ scale: 1 });
              var scale = width / vp.width;
              vp = page.getViewport({ scale: scale });
              var c = document.createElement("canvas");
              c.width = vp.width; c.height = vp.height;
              page.render({ canvasContext: c.getContext("2d"), viewport: vp })
                .promise.then(function () {
                  var img = new Image();
                  img.dataset.paintMode = "text";
                  // once-only: the painter re-assigns img.src per frame,
                  // which would re-fire a plain onload and cascade into
                  // duplicate page renders
                  img.addEventListener("load", function () {
                    holder.appendChild(img);
                    frame.style.display = "none"; // only once pages exist
                    if (on) {
                      queue.push({ kind: "img", el: img });
                      workers.forEach(function (w) { if (!w.busy) pump(w); });
                    }
                    renderPage(num + 1);
                  }, { once: true });
                  img.src = c.toDataURL("image/png");
                });
            });
          };
          renderPage(1);
        }).catch(function (err) {
          console.warn("paint-mode: PDF render failed, leaving iframe", err);
          frame.style.display = "";
        });
      });
    }).catch(function (err) {
      console.warn("paint-mode: pdf.js unavailable, skipping PDFs", err);
    });
  }

  // ------------------------------------------------------------- engine

  function pump(worker) {
    if (!on) { worker.busy = null; return; }
    var pick = -1;
    for (var i = 0; i < queue.length; i++) {
      if (!queue[i].el.isConnected || queue[i].el.dataset.painting) {
        queue.splice(i, 1); i--; continue;
      }
      if (nearViewport(queue[i].el)) { pick = i; break; }
      if (pick < 0) pick = i;
    }
    if (pick < 0) { worker.busy = null; return; }
    var entry = queue.splice(pick, 1)[0];
    var ok = entry.kind === "img" ? startImgJob(worker, entry.el)
      : entry.kind === "icon" ? startIconJob(worker, entry.el)
      : startBlockJob(worker, entry.el);
    if (!ok) pump(worker);
  }

  // Double-buffered presentation: decode the new frame fully, then swap.
  // Throttled per job so many concurrent streams stay smooth.
  function present(job) {
    var now = Date.now();
    if (job.presenting || now - (job.lastPresent || 0) < 120) {
      job.dirty = true;
      if (!job.trail && !job.presenting) {
        job.trail = setTimeout(function () {
          job.trail = null;
          if (job.dirty) { job.dirty = false; present(job); }
        }, 130);
      }
      return;
    }
    job.lastPresent = now;
    job.presenting = true;
    var type = job.png ? "image/png" : "image/jpeg";
    job.buf.toBlob(function (blob) {
      if (!blob || !job.el.dataset.painting) { job.presenting = false; return; }
      var url = URL.createObjectURL(blob);
      var pre = new Image();
      pre.src = url;
      var apply = function () {
        if (job.el.dataset.painting) {
          if (job.kind === "img") job.el.src = url;
          else {
            job.el.style.backgroundImage = "url(" + url + ")";
            job.el.style.backgroundSize = "100% 100%";
            job.el.style.backgroundRepeat = "no-repeat";
          }
          if (job.url) URL.revokeObjectURL(job.url);
          job.url = url;
        } else URL.revokeObjectURL(url);
        job.presenting = false;
        if (job.dirty) { job.dirty = false; present(job); }
      };
      (pre.decode ? pre.decode().then(apply, apply) : (pre.onload = apply));
    }, type, 0.92);
  }

  function onMessage(worker, e) {
    var msg = e.data;
    var job = jobs[msg.id];
    if (msg.type === "skip") {
      // unpaintable (no ink) — restore the element untouched
      if (job) {
        job.el.classList.remove("paint-block");
        delete job.el.dataset.painting;
        delete jobs[msg.id];
      }
      pump(worker);
      return;
    }
    if (job && job.el.isConnected && job.el.dataset.painting) {
      job.ctx.putImageData(
        new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height), 0, 0
      );
      present(job);
    }
    if (msg.type === "done") {
      delete jobs[msg.id];
      pump(worker);
    }
  }

  // If everything is busy painting offscreen work while the visitor is
  // looking at unpainted content, preempt one offscreen job.
  var scrollTimer = null;
  function onScroll() {
    if (!on || scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      var visibleWaiting = queue.some(function (q) {
        return q.el.isConnected && nearViewport(q.el);
      });
      if (!visibleWaiting) return;
      workers.forEach(function (w) {
        if (!w.busy) { pump(w); return; }
        var job = jobs[w.busy];
        if (job && !nearViewport(job.el)) {
          delete jobs[w.busy];
          delete job.el.dataset.painting;
          queue.push({ kind: job.kind, el: job.el });
          w.terminate();
          var idx = workers.indexOf(w);
          var nw = new Worker(WORKER_URL);
          nw.onmessage = function (e) { onMessage(nw, e); };
          workers[idx] = nw;
          pump(nw);
        }
      });
    }, 250);
  }

  function enqueue(entries) {
    var added = 0;
    entries.forEach(function (entry) {
      if (entry.el.dataset.paintSeen) return;
      entry.el.dataset.paintSeen = "1";
      queue.push(entry);
      added++;
    });
    if (added) workers.forEach(function (w) { if (!w.busy) pump(w); });
    return added;
  }

  function collectAll() {
    var imgs = Array.prototype.filter.call(document.querySelectorAll("img"), eligibleImg)
      .map(function (el) { return { kind: "img", el: el }; });
    var blocks = collectBlocks()
      .map(function (el) { return { kind: "block", el: el }; });
    var icons = collectIcons()
      .map(function (el) { return { kind: "icon", el: el }; });
    return imgs.sort(byViewport).concat(blocks.sort(byViewport), icons);
  }

  // Content added after painting starts (fetch-rendered sections,
  // infinite scroll, future widgets) joins the queue automatically.
  var domTimer = null;
  var domWatch = typeof MutationObserver !== "undefined"
    ? new MutationObserver(function () {
        if (!on || domTimer) return;
        domTimer = setTimeout(function () {
          domTimer = null;
          if (on) enqueue(collectAll());
        }, 300);
      })
    : null;

  function start() {
    var all = document.querySelectorAll("img");
    Array.prototype.forEach.call(all, function (img) {
      if (!img.complete && !img.dataset.paintHooked) {
        img.dataset.paintHooked = "1";
        img.addEventListener("load", function () {
          if (on && eligibleImg(img) && !img.dataset.painting) {
            queue.push({ kind: "img", el: img });
            workers.forEach(function (w) { if (!w.busy) pump(w); });
          }
        }, { once: true });
      }
    });
    queue = [];
    enqueue(collectAll());
    if (domWatch) domWatch.observe(document.body, { childList: true, subtree: true });
    for (var i = workers.length; i < POOL; i++) {
      (function () {
        var w = new Worker(WORKER_URL);
        w.onmessage = function (e) { onMessage(w, e); };
        workers.push(w);
      })();
    }
    workers.forEach(function (w) { if (!w.busy) pump(w); });
    expandPdfFrames();
    addEventListener("scroll", onScroll, { passive: true });
  }

  function stop() {
    removeEventListener("scroll", onScroll);
    if (domWatch) domWatch.disconnect();
    document.querySelectorAll("[data-paint-seen]").forEach(function (el) {
      delete el.dataset.paintSeen;
    });
    workers.forEach(function (w) { w.terminate(); });
    workers = [];
    jobs = {};
    queue = [];
    // pdf pages stay inline (a feature independent of paint mode);
    // their crisp originals come back via the origSrc restore below
    document.querySelectorAll("img[data-painting]").forEach(function (img) {
      if (img.src.indexOf("blob:") === 0) URL.revokeObjectURL(img.src);
      img.src = img.dataset.origSrc;
      delete img.dataset.painting;
      delete img.dataset.origSrc;
      var picture = img.closest("picture");
      if (picture) {
        picture.querySelectorAll("source").forEach(function (s) {
          if (s.dataset.srcset) { s.srcset = s.dataset.srcset; delete s.dataset.srcset; }
        });
      }
    });
    document.querySelectorAll(".paint-block").forEach(function (el) {
      restoreBlock(el, false);
      delete el.dataset.paintSkip;
    });
    document.querySelectorAll("img.paint-icon").forEach(function (im) {
      if (im.src.indexOf("blob:") === 0) URL.revokeObjectURL(im.src);
      im.remove();
    });
    document.querySelectorAll("svg[data-painting]").forEach(function (svg) {
      svg.style.display = "";
      delete svg.dataset.painting;
    });
  }

  function setMode(next) {
    on = next;
    localStorage.setItem(KEY, on ? "1" : "0");
    var btn = document.getElementById("paint-toggle");
    if (btn) {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("data-label", on ? "back to reality" : "paint the site");
    }
    if (on) start();
    else stop();
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    // inline PDF pages are a page feature, not a paint-mode feature
    if (document.readyState === "complete") expandPdfFrames();
    else addEventListener("load", expandPdfFrames, { once: true });
    var btn = document.getElementById("paint-toggle");
    if (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        setMode(!on);
      });
    }
    var forced = new URLSearchParams(location.search).get("paint") === "1";
    if (forced || localStorage.getItem(KEY) === "1") {
      // wait for stylesheets/images (async CSS!) plus a layout frame, or
      // blocks get rasterized with unstyled geometry
      var go = function () {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setMode(true); });
        });
      };
      if (document.readyState === "complete") go();
      else addEventListener("load", go, { once: true });
    }
  });
})();
