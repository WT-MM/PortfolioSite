// Genetic painting in the browser: a Web Worker port of
// github.com/WT-MM/GeneticPainting. Pure typed-array math, no canvas —
// brushes are rasterized procedurally so this also runs under Node for
// testing. Protocol: {cmd:"paint", id, width, height, data(RGBA buffer)}
// in; {type:"frame"|"done", id, data(RGBA buffer)} out.

"use strict";

// ---------------------------------------------------------------- brushes

function makeBrush(rand, size) {
  // A textured fiber stroke: wobbly low-alpha polylines around a curved
  // centerline, tapered at the ends (port of shapes.py --style stroke).
  var w = size, h = size >> 1;
  var acc = new Float32Array(w * h);
  var margin = w / 8;
  var n = 50 + ((rand() * 40) | 0);
  var y0 = h * (0.5 + (rand() - 0.5) * 0.16);
  var curve = (rand() - 0.5) * 0.3 * h;
  var slope = (rand() - 0.5) * 0.12 * h;
  var body = h * (0.08 + rand() * 0.12);

  for (var f = 0; f < n; f++) {
    var off = gauss(rand) * body;
    var alpha = 0.06 + rand() * 0.2;
    var wobble = 0, px = -1, py = -1;
    for (var k = 0; k < 60; k++) {
      var t = k / 59;
      var x = margin + t * (w - 2 * margin);
      wobble += gauss(rand) * 0.5;
      var y = y0 + curve * (2 * t - 1) * (2 * t - 1) + slope * (2 * t - 1) + off + wobble;
      if (px >= 0) drawLine(acc, w, h, px, py, x, y, alpha);
      px = x; py = y;
    }
  }
  // taper + clamp + light blur
  for (var yy = 0; yy < h; yy++) {
    for (var xx = 0; xx < w; xx++) {
      var taper = Math.sqrt(Math.sin((Math.PI * xx) / w));
      var i = yy * w + xx;
      acc[i] = Math.min(1, acc[i]) * taper;
    }
  }
  boxBlur(acc, w, h, 1);
  return crop({ data: acc, w: w, h: h });
}

function gauss(rand) {
  var u = 1 - rand(), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function drawLine(acc, w, h, x0, y0, x1, y1, alpha) {
  var dx = x1 - x0, dy = y1 - y0;
  var steps = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
  for (var s = 0; s <= steps; s++) {
    var x = (x0 + (dx * s) / (steps || 1)) | 0;
    var y = (y0 + (dy * s) / (steps || 1)) | 0;
    if (x >= 0 && x < w && y >= 0 && y < h) {
      var i = y * w + x;
      acc[i] = Math.min(1.5, acc[i] + alpha);
    }
  }
}

function boxBlur(a, w, h, r) {
  var tmp = new Float32Array(a.length);
  var norm = 1 / (2 * r + 1);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var s = 0;
      for (var k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s * norm;
    }
  }
  for (var x2 = 0; x2 < w; x2++) {
    for (var y2 = 0; y2 < h; y2++) {
      var s2 = 0;
      for (var k2 = -r; k2 <= r; k2++) s2 += tmp[Math.min(h - 1, Math.max(0, y2 + k2)) * w + x2];
      a[y2 * w + x2] = s2 * norm;
    }
  }
}

function crop(b) {
  var minX = b.w, maxX = -1, minY = b.h, maxY = -1;
  for (var y = 0; y < b.h; y++)
    for (var x = 0; x < b.w; x++)
      if (b.data[y * b.w + x] > 0.02) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return b;
  var w = maxX - minX + 1, h = maxY - minY + 1;
  var out = new Float32Array(w * h);
  for (var y2 = 0; y2 < h; y2++)
    for (var x2 = 0; x2 < w; x2++)
      out[y2 * w + x2] = b.data[(y2 + minY) * b.w + (x2 + minX)];
  return { data: out, w: w, h: h };
}

function halve(b) {
  var w = Math.max(1, b.w >> 1), h = Math.max(1, b.h >> 1);
  var out = new Float32Array(w * h);
  for (var y = 0; y < h; y++)
    for (var x = 0; x < w; x++) {
      var sy = 2 * y, sx = 2 * x;
      var s = b.data[sy * b.w + sx];
      var c = 1;
      if (sx + 1 < b.w) { s += b.data[sy * b.w + sx + 1]; c++; }
      if (sy + 1 < b.h) { s += b.data[(sy + 1) * b.w + sx]; c++; }
      if (sx + 1 < b.w && sy + 1 < b.h) { s += b.data[(sy + 1) * b.w + sx + 1]; c++; }
      out[y * w + x] = s / c;
    }
  return { data: out, w: w, h: h };
}

function makeBrushSet(seed) {
  var state = seed >>> 0;
  var rand = function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  var brushes = [];
  for (var i = 0; i < 6; i++) {
    var levels = [makeBrush(rand, 192)];
    while (Math.max(levels[levels.length - 1].w, levels[levels.length - 1].h) >= 10)
      levels.push(halve(levels[levels.length - 1]));
    brushes.push(levels);
  }
  return { brushes: brushes, rand: rand };
}

// ---------------------------------------------------------------- painting

function Painter(width, height, rgba, seed, focus, mode, bg, inkCap) {
  this.inkCap = inkCap || 7000;
  this.focus = focus || null; // {x, y, r} in normalized [0,1] coords
  // "text" mode: ink-on-background painting. The canvas starts at the
  // exact background color, so the error map is a mask of the ink —
  // only glyphs attract strokes — and frames are emitted with alpha so
  // the untouched background stays fully transparent.
  this.textMode = mode === "text";
  this.bg = bg || [255, 255, 255];
  var set = makeBrushSet(seed || 7);
  this.rand = set.rand;
  this.brushes = set.brushes;
  this.w = width;
  this.h = height;
  var n = width * height;
  this.ref = new Float32Array(n * 3);
  var mr = 0, mg = 0, mb = 0;
  for (var i = 0; i < n; i++) {
    var a = rgba[i * 4 + 3] / 255;
    // composite transparent pixels over white
    var r = rgba[i * 4] * a + 255 * (1 - a);
    var g = rgba[i * 4 + 1] * a + 255 * (1 - a);
    var b = rgba[i * 4 + 2] * a + 255 * (1 - a);
    this.ref[i * 3] = r; this.ref[i * 3 + 1] = g; this.ref[i * 3 + 2] = b;
    mr += r; mg += g; mb += b;
  }
  this.canvas = new Float32Array(n * 3);
  var c0 = this.textMode ? this.bg : [mr / n, mg / n, mb / n];
  for (var j = 0; j < n; j++) {
    this.canvas[j * 3] = c0[0];
    this.canvas[j * 3 + 1] = c0[1];
    this.canvas[j * 3 + 2] = c0[2];
  }
  this.buildGuides();
  this.err = new Float32Array(n);
  for (var k = 0; k < n; k++) this.err[k] = this.pixelErr(k);
  this.cell = 8;
  this.gw = Math.ceil(width / this.cell);
  this.gh = Math.ceil(height / this.cell);
  this.cellErr = new Float32Array(this.gw * this.gh);
  this.rebuildCells();
  this.stroke = 0;
  var short = Math.min(width, height);
  if (this.textMode) {
    // Budget follows the amount of ink, not the block area. A block
    // with almost no ink (low-contrast text on its own highlight) is
    // not paintable — signal the caller to leave it alone.
    var ink = 0;
    for (var q = 0; q < n; q++) if (this.err[q] > 60) ink++;
    this.skip = ink < 30;
    this.total = Math.max(250, Math.min(this.inkCap, (ink / 2.5) | 0));
    this.refine = (this.total * 0.45) | 0;
  } else {
    this.total = Math.max(450, Math.min(3000, (n / 300) | 0));
    // an explicit focus region earns a bigger, finer refinement pass
    this.refine = (this.total * (this.focus ? 0.75 : 0.55)) | 0;
  }
  // Masked evolution: after the coarse pass, extra small strokes go
  // where fine detail lives (and into the requested focus region).
  this.maxSize = short * 0.45;
  this.minSize = Math.max(4, short * 0.017);
  this.phase = 0;
}

Painter.prototype.pixelErr = function (i) {
  var d = Math.abs(this.ref[i * 3] - this.canvas[i * 3]) +
          Math.abs(this.ref[i * 3 + 1] - this.canvas[i * 3 + 1]) +
          Math.abs(this.ref[i * 3 + 2] - this.canvas[i * 3 + 2]);
  return d * this.weight[i];
};

Painter.prototype.buildGuides = function () {
  var w = this.w, h = this.h, n = w * h;
  var gray = new Float32Array(n);
  for (var i = 0; i < n; i++)
    gray[i] = 0.114 * this.ref[i * 3] + 0.587 * this.ref[i * 3 + 1] + 0.299 * this.ref[i * 3 + 2];
  var gx = new Float32Array(n), gy = new Float32Array(n);
  for (var y = 1; y < h - 1; y++)
    for (var x = 1; x < w - 1; x++) {
      var i2 = y * w + x;
      gx[i2] = gray[i2 + 1] - gray[i2 - 1];
      gy[i2] = gray[i2 + w] - gray[i2 - w];
    }
  boxBlur(gx, w, h, 3);
  boxBlur(gy, w, h, 3);
  this.weight = new Float32Array(n);
  this.angle = new Float32Array(n);
  this.oriented = new Uint8Array(n);
  var mean = 0;
  var mag = new Float32Array(n);
  for (var j = 0; j < n; j++) {
    mag[j] = Math.hypot(gx[j], gy[j]);
    mean += mag[j];
  }
  mean /= n;
  var ref95 = Math.max(mean * 3, 1e-6);
  for (var k = 0; k < n; k++) {
    this.weight[k] = 1 + 2 * Math.min(1, mag[k] / ref95);
    if (mag[k] > 0.5) {
      // stroke direction = edge tangent (perpendicular to the gradient)
      this.angle[k] = Math.atan2(gx[k], -gy[k]);
      this.oriented[k] = 1;
    }
  }

  // Detail mask: fine-scale local contrast (|gray - blur(gray)|),
  // normalized — faces, eyes and small text score high. The focus
  // region, when given, dominates.
  var smooth = new Float32Array(gray);
  boxBlur(smooth, w, h, 2);
  this.detail = new Float32Array(n);
  var dmean = 0;
  for (var d = 0; d < n; d++) {
    this.detail[d] = Math.abs(gray[d] - smooth[d]);
    dmean += this.detail[d];
  }
  dmean = Math.max(dmean / n, 1e-6);
  for (var d2 = 0; d2 < n; d2++)
    this.detail[d2] = Math.min(1, this.detail[d2] / (dmean * 3));
  boxBlur(this.detail, w, h, 3);
  if (this.focus) {
    var fx = this.focus.x * w, fy = this.focus.y * h;
    var fr = Math.max(1, this.focus.r * Math.min(w, h));
    for (var y3 = 0; y3 < h; y3++)
      for (var x3 = 0; x3 < w; x3++) {
        var dist = Math.hypot(x3 - fx, y3 - fy) / fr;
        if (dist < 1) {
          var t = 1 - dist;
          var i3 = y3 * w + x3;
          this.detail[i3] = Math.min(4, this.detail[i3] + 4 * t * t);
        }
      }
  }
};

Painter.prototype.rebuildCells = function () {
  this.cellErr.fill(0);
  var refining = this.phase === 1;
  for (var y = 0; y < this.h; y++) {
    var cy = (y / this.cell) | 0;
    for (var x = 0; x < this.w; x++) {
      var i = y * this.w + x;
      var e = this.err[i];
      if (refining) e *= 0.25 + 3 * this.detail[i];
      this.cellErr[cy * this.gw + ((x / this.cell) | 0)] += e;
    }
  }
  // prefix sums so sampling is a binary search, not a linear scan
  if (!this.cellCum || this.cellCum.length !== this.cellErr.length)
    this.cellCum = new Float64Array(this.cellErr.length);
  var acc = 0;
  for (var j = 0; j < this.cellErr.length; j++) {
    acc += this.cellErr[j];
    this.cellCum[j] = acc;
  }
  this.cellTotal = acc;
};

Painter.prototype.samplePos = function () {
  var r = this.rand() * this.cellTotal;
  var lo = 0, hi = this.cellCum.length - 1;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (this.cellCum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  var cy = (lo / this.gw) | 0, cx = lo % this.gw;
  return {
    x: Math.min(this.w - 1, (cx + this.rand()) * this.cell),
    y: Math.min(this.h - 1, (cy + this.rand()) * this.cell),
  };
};

Painter.prototype.randomStroke = function (lo, hi) {
  var p = this.samplePos();
  var pi = (p.y | 0) * this.w + (p.x | 0);
  var angle;
  if (this.oriented[pi] && this.rand() < 0.7) angle = this.angle[pi] + gauss(this.rand) * 0.25;
  else angle = this.rand() * Math.PI * 2;
  return {
    brush: (this.rand() * this.brushes.length) | 0,
    cx: p.x, cy: p.y,
    size: lo + this.rand() * (hi - lo),
    angle: angle,
    // ink needs dense coverage; painterly images can be translucent
    opacity: this.textMode ? 0.85 + this.rand() * 0.15 : 0.6 + this.rand() * 0.4,
    bias: this.rand() * 0.5,
  };
};

Painter.prototype.mutate = function (s, lo, hi) {
  return {
    brush: this.rand() < 0.1 ? (this.rand() * this.brushes.length) | 0 : s.brush,
    cx: Math.min(this.w - 1, Math.max(0, s.cx + gauss(this.rand) * s.size * 0.25)),
    cy: Math.min(this.h - 1, Math.max(0, s.cy + gauss(this.rand) * s.size * 0.25)),
    size: Math.min(hi, Math.max(lo, s.size * (0.8 + this.rand() * 0.45))),
    angle: s.angle + (this.rand() - 0.5) * 1.0,
    opacity: Math.min(1, Math.max(0.4, s.opacity + (this.rand() - 0.5) * 0.2)),
    bias: Math.min(1, Math.max(0, s.bias + (this.rand() - 0.5) * 0.4)),
  };
};

// Evaluate (and optionally commit) a stroke: rotated-scaled brush sample
// via inverse mapping from the nearest mip level, footprint-mean color
// blended toward the center color, weighted L1 delta over the tile.
Painter.prototype.applyStroke = function (s, commit) {
  var levels = this.brushes[s.brush];
  var lvl = levels[0];
  for (var li = 1; li < levels.length; li++) {
    if (Math.max(levels[li].w, levels[li].h) < s.size) break;
    lvl = levels[li];
  }
  var scale = s.size / Math.max(lvl.w, lvl.h);
  var bw = lvl.w * scale, bh = lvl.h * scale;
  var cos = Math.cos(s.angle), sin = Math.sin(s.angle);
  var half = (Math.abs(cos) * bw + Math.abs(sin) * bh) / 2;
  var vhalf = (Math.abs(sin) * bw + Math.abs(cos) * bh) / 2;
  var x0 = Math.max(0, (s.cx - half) | 0), x1 = Math.min(this.w - 1, (s.cx + half) | 0);
  var y0 = Math.max(0, (s.cy - vhalf) | 0), y1 = Math.min(this.h - 1, (s.cy + vhalf) | 0);
  if (x1 <= x0 || y1 <= y0) return Infinity;

  // hoist hot fields — property lookups cost in these loops
  var W = this.w, ref = this.ref, canvas = this.canvas;
  var err = this.err, weight = this.weight;
  var tw = x1 - x0 + 1, th = y1 - y0 + 1;
  if (!this.scratch || this.scratch.length < tw * th)
    this.scratch = new Float32Array(tw * th);
  var masks = this.scratch;

  // pass 1: sample the brush once, accumulate the footprint color
  var sr = 0, sg = 0, sb = 0, sm = 0;
  var lw = lvl.w, lh = lvl.h, ldata = lvl.data;
  var inv = 1 / scale, op = s.opacity;
  for (var y = y0; y <= y1; y++) {
    var dy = y - s.cy;
    var row = (y - y0) * tw - x0;
    for (var x = x0; x <= x1; x++) {
      var dx = x - s.cx;
      var u = (cos * dx + sin * dy) * inv + lw / 2;
      var v = (cos * dy - sin * dx) * inv + lh / 2;
      var m = 0;
      if (u >= 0 && v >= 0 && u < lw && v < lh) m = ldata[(v | 0) * lw + (u | 0)];
      if (m > 0) {
        m *= op;
        var i = (y * W + x) * 3;
        sr += ref[i] * m; sg += ref[i + 1] * m; sb += ref[i + 2] * m;
        sm += m;
      }
      masks[row + x] = m;
    }
  }
  if (sm <= 0) return Infinity;
  var ci = ((s.cy | 0) * W + (s.cx | 0)) * 3;
  var b = s.bias;
  var cr = ((1 - b) * sr) / sm + b * ref[ci];
  var cg = ((1 - b) * sg) / sm + b * ref[ci + 1];
  var cb = ((1 - b) * sb) / sm + b * ref[ci + 2];

  // pass 2: delta (and commit) from the cached mask
  var delta = 0;
  for (var y2 = y0; y2 <= y1; y2++) {
    var row2 = (y2 - y0) * tw - x0;
    for (var x2 = x0; x2 <= x1; x2++) {
      var m2 = masks[row2 + x2];
      if (m2 <= 0) continue;
      var pi = y2 * W + x2;
      var i2 = pi * 3;
      var nr = canvas[i2] + m2 * (cr - canvas[i2]);
      var ng = canvas[i2 + 1] + m2 * (cg - canvas[i2 + 1]);
      var nb = canvas[i2 + 2] + m2 * (cb - canvas[i2 + 2]);
      var ne = (Math.abs(ref[i2] - nr) + Math.abs(ref[i2 + 1] - ng) +
                Math.abs(ref[i2 + 2] - nb)) * weight[pi];
      delta += ne - err[pi];
      if (commit) {
        canvas[i2] = nr; canvas[i2 + 1] = ng; canvas[i2 + 2] = nb;
        err[pi] = ne;
      }
    }
  }
  return delta;
};

Painter.prototype.paintOne = function () {
  var lo, hi;
  if (this.textMode) {
    // Ink is glyph-scale from the first stroke: no coarse phase.
    lo = 3;
    hi = Math.max(9, this.minSize * 1.5);
  } else if (this.stroke < this.total) {
    var t = this.stroke / Math.max(1, this.total - 1);
    var center = this.maxSize * Math.pow(this.minSize / this.maxSize, t);
    lo = center * 0.6;
    hi = center * 1.4;
  } else {
    if (this.phase === 0) {
      this.phase = 1;
      this.rebuildCells();
    }
    lo = 3;
    hi = this.focus ? this.minSize * 1.5 : this.minSize * 2.5;
  }
  var POP = 10, GENS = 4, ELITE = 3;
  var pop = [];
  for (var i = 0; i < POP; i++) {
    var s = this.randomStroke(lo, hi);
    pop.push({ s: s, d: this.applyStroke(s, false) });
  }
  pop.sort(function (a, b) { return a.d - b.d; });
  for (var g = 1; g < GENS; g++) {
    for (var c = ELITE; c < POP; c++) {
      var child = this.mutate(pop[c % ELITE].s, lo, hi);
      pop[c] = { s: child, d: this.applyStroke(child, false) };
    }
    pop.sort(function (a, b) { return a.d - b.d; });
  }
  if (pop[0].d < 0) this.applyStroke(pop[0].s, true);
  this.stroke++;
  if (this.stroke % 12 === 0) this.rebuildCells();
  return this.stroke < this.total + this.refine;
};

Painter.prototype.frame = function () {
  var n = this.w * this.h;
  var out = new Uint8ClampedArray(n * 4);
  for (var i = 0; i < n; i++) {
    out[i * 4] = this.canvas[i * 3];
    out[i * 4 + 1] = this.canvas[i * 3 + 1];
    out[i * 4 + 2] = this.canvas[i * 3 + 2];
    if (this.textMode) {
      // background stays transparent; only painted ink shows
      var d = Math.abs(this.canvas[i * 3] - this.bg[0]) +
              Math.abs(this.canvas[i * 3 + 1] - this.bg[1]) +
              Math.abs(this.canvas[i * 3 + 2] - this.bg[2]);
      out[i * 4 + 3] = Math.min(255, d * 6);
    } else {
      out[i * 4 + 3] = 255;
    }
  }
  return out;
};

// ---------------------------------------------------------------- worker

if (typeof onmessage !== "undefined" || typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = function (e) {
    var msg = e.data;
    if (msg.cmd !== "paint") return;
    var p = new Painter(msg.width, msg.height, new Uint8ClampedArray(msg.data), msg.seed,
                        msg.focus, msg.mode, msg.bg, msg.inkCap);
    if (p.skip) {
      self.postMessage({ type: "skip", id: msg.id });
      return;
    }
    // Time-sliced: ~40ms of strokes per tick, frames at most every ~100ms.
    var lastFrame = 0;
    function tick() {
      var t0 = Date.now();
      var more = true;
      while (more && Date.now() - t0 < 40) more = p.paintOne();
      var now = Date.now();
      if (!more || now - lastFrame >= 100) {
        lastFrame = now;
        var buf = p.frame().buffer;
        self.postMessage(
          { type: more ? "frame" : "done", id: msg.id, width: p.w, height: p.h, data: buf },
          [buf]
        );
      }
      if (more) setTimeout(tick, 0);
    }
    tick();
  };
}

if (typeof module !== "undefined") module.exports = { Painter: Painter };
