/* ==========================================================================
   Hero scan replay.

   Takes the real occupancy grid the rover exported and reveals it the way the
   rover built it: one revolution of a spinning beam, sweeping out from the
   pose it was standing at. The instrument furniture (range rings at one metre
   intervals, red world axes) is drawn from the same numbers the SLAM code uses
   — 30 mm per cell, 4 px per cell on export, so 7.5 mm per image pixel.

   Degrades to a still map when JS is unavailable, the image fails, or the
   viewer has asked for reduced motion.
   ========================================================================== */

(function () {
  "use strict";

  var canvas = document.getElementById("sweep");
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext("2d");

  var MAP_SRC = "maps/map-traverse.png";
  var MM_PER_PX = 7.5;               // 30 mm cell / 4 px per cell on export
  var ORIGIN = { x: 0.665, y: 0.52 };  // rover pose, as a fraction of the map
  var REVEAL_MS = 2800;
  var AMBIENT_MS = 9000;

  var reduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var map = null;        // black keyed out, sized to the backing store
  var fit = null;        // placement of the map inside the canvas
  var startedAt = 0;
  var running = false;
  var rafId = 0;
  var W = 0, H = 0, dpr = 1;

  /* ---- load + key out the background ----------------------------------- */

  var img = new Image();
  img.decoding = "async";

  img.onerror = function () {
    // Nothing clever to do — hand the reader the plain file instead.
    var fallback = new Image();
    fallback.src = MAP_SRC;
    fallback.alt = "Occupancy grid exported by LOLA.";
    if (canvas.parentNode) canvas.parentNode.replaceChild(fallback, canvas);
  };

  img.onload = function () {
    measure();
    observe();
  };

  img.src = MAP_SRC;

  /* Rebuild the keyed map at the current backing-store size. The exported PNG
     paints unknown space as solid black; dropping it to transparent lets the
     range rings read underneath the map instead of being buried by it. */
  function buildMap() {
    if (!img.naturalWidth) return;

    var scale = Math.min(fit.w / img.naturalWidth, fit.h / img.naturalHeight);
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));

    var off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    var octx = off.getContext("2d");
    octx.drawImage(img, 0, 0, w, h);

    try {
      var data = octx.getImageData(0, 0, w, h);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        // Anything essentially black is unobserved space, not a wall face.
        if (px[i] < 26 && px[i + 1] < 26 && px[i + 2] < 26) px[i + 3] = 0;
      }
      octx.putImageData(data, 0, 0);
    } catch (e) {
      // Tainted canvas (file:// in some browsers) — keep the opaque version.
    }

    map = { canvas: off, w: w, h: h, x: fit.x + (fit.w - w) / 2, y: fit.y + (fit.h - h) / 2 };
  }

  /* ---- layout ----------------------------------------------------------- */

  function measure() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(rect.width * dpr);
    H = Math.round(rect.height * dpr);
    canvas.width = W;
    canvas.height = H;

    var inset = 18 * dpr;
    fit = { x: inset, y: inset, w: W - inset * 2, h: H - inset * 2 };

    buildMap();
    draw(reduced ? 1 : progress());
  }

  function origin() {
    return {
      x: map.x + map.w * ORIGIN.x,
      y: map.y + map.h * ORIGIN.y
    };
  }

  /* ---- painting --------------------------------------------------------- */

  function drawRings(o) {
    var pxPerMetre = (map.w / img.naturalWidth) * (1000 / MM_PER_PX);
    var reach = Math.hypot(Math.max(o.x, W - o.x), Math.max(o.y, H - o.y));

    ctx.lineWidth = 1;
    ctx.font = (10 * dpr) + "px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textBaseline = "alphabetic";

    for (var m = 1; m * pxPerMetre < reach; m++) {
      var r = m * pxPerMetre;
      ctx.strokeStyle = "rgba(255,255,255,.075)";
      ctx.beginPath();
      ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
      ctx.stroke();

      if (m % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,.24)";
        ctx.fillText(m + "m", o.x + 5 * dpr, o.y - r - 4 * dpr);
      }
    }

    // World axes, in the rover's own red
    ctx.strokeStyle = "rgba(255,59,48,.30)";
    ctx.beginPath();
    ctx.moveTo(0, o.y); ctx.lineTo(W, o.y);
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, H);
    ctx.stroke();
  }

  /* glow: draw the afterglow wedge only during the first reveal. Left running
     underneath the finished map it just reads as a smudge. */
  function drawBeam(o, angle, alpha, glow) {
    var reach = Math.hypot(W, H);
    var tail = 0.42;                       // radians of afterglow behind the beam

    var grad = glow && ctx.createConicGradient
      ? ctx.createConicGradient(angle - tail, o.x, o.y)
      : null;

    if (grad) {
      grad.addColorStop(0, "rgba(0,255,0,0)");
      grad.addColorStop(tail / (Math.PI * 2), "rgba(0,255,0," + (0.16 * alpha) + ")");
      grad.addColorStop(tail / (Math.PI * 2) + 0.0001, "rgba(0,255,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.arc(o.x, o.y, reach, angle - tail, angle);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(0,255,0," + (0.55 * alpha) + ")";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + Math.cos(angle) * reach, o.y + Math.sin(angle) * reach);
    ctx.stroke();
  }

  function drawRover(o) {
    ctx.fillStyle = "#00ff00";
    ctx.beginPath();
    ctx.arc(o.x, o.y, 3.5 * dpr, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(0,255,0,.35)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(o.x, o.y, 8 * dpr, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* t: 0 → 1 across the reveal, then >1 for the ambient pass */
  function draw(t) {
    if (!map || !fit) return;

    var o = origin();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    drawRings(o);

    var revealed = Math.min(t, 1);
    var angle = -Math.PI / 2 + revealed * Math.PI * 2;

    if (revealed >= 1) {
      ctx.drawImage(map.canvas, map.x, map.y);
    } else if (revealed > 0) {
      var reach = Math.hypot(W, H);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.arc(o.x, o.y, reach, -Math.PI / 2, angle);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(map.canvas, map.x, map.y);
      ctx.restore();
    }

    if (!reduced) {
      if (t < 1) {
        drawBeam(o, angle, 1, true);
      } else {
        // Ambient revolution, quiet enough to ignore
        var phase = ((t - 1) * REVEAL_MS / AMBIENT_MS) % 1;
        drawBeam(o, -Math.PI / 2 + phase * Math.PI * 2, 0.22, false);
      }
    }

    drawRover(o);
  }

  /* ---- loop ------------------------------------------------------------- */

  function progress() {
    return startedAt ? (performance.now() - startedAt) / REVEAL_MS : 0;
  }

  function frame() {
    if (!running) return;
    draw(progress());
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduced) return;
    running = true;
    if (!startedAt) startedAt = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  /* Only animate while the hero is actually on screen. */
  function observe() {
    if (reduced) { startedAt = performance.now() - REVEAL_MS; draw(1); return; }

    if (!("IntersectionObserver" in window)) { start(); return; }

    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) start(); else stop();
      });
    }, { threshold: 0.05 }).observe(canvas);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else if (startedAt) start();
  });

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, 160);
  });
})();
