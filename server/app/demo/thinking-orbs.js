/**
 * Thinking Orbs — Vanilla JS Engine
 * Dotted thought-orb loading indicators for AI and agent UIs
 * Original geometry & algorithms by Jakub Antalik (MIT)
 *
 * Nine states:
 * - working: particles on tilted orbits
 * - searching: scan meridian sweeping a dotted globe
 * - solving: scramble & solve Rubik cube
 * - listening: waveform through rings
 * - connecting: constellation network
 * - weaving: three braided strands
 * - composing: undulating multi-band ribbon
 * - breathing: slowly morphing ring (idle)
 * - shaping: circle -> triangle -> square morph
 */
(function (global) {
  'use strict';

  function lerp(a, b, f) {
    return a + (b - a) * f;
  }
  function frac(x) {
    return x - Math.floor(x);
  }
  function hashD(a, b) {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }
  function vnoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hashD(xi, yi);
    const b = hashD(xi + 1, yi);
    const c = hashD(xi, yi + 1);
    const d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fibDir(i, n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }
  function angleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }
  function makeProj(yaw, tilt, cx, cy, scale) {
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);
    const sy = Math.sin(yaw);
    const cyw = Math.cos(yaw);
    return function (x, y, z) {
      const x1 = x * cyw + z * sy;
      const z1 = -x * sy + z * cyw;
      const y1 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };
  }
  function radiusScale(size, pow) {
    return Math.pow(size / 300, pow);
  }

  function inkColor(w, alpha, dark, tint) {
    if (!tint) {
      const g = Math.round((dark ? 1 - w : w) * 255);
      return 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')';
    }
    const ramp = (c) => Math.round(dark ? c * (1 - w) : c + (255 - c) * w);
    return 'rgba(' + ramp(tint.r) + ',' + ramp(tint.g) + ',' + ramp(tint.b) + ',' + alpha + ')';
  }

  function paint(ctx, dots, dark, rMin, tint) {
    rMin = rMin || 0.3;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const alpha = d.a != null ? d.a : 1;
      const w = Math.min(1, Math.max(0, d.white));
      ctx.fillStyle = inkColor(w, alpha, dark, tint);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paintLines(ctx, lines, dark, tint) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const alpha = l.a != null ? l.a : 1;
      const w = Math.min(1, Math.max(0, l.white));
      ctx.strokeStyle = inkColor(w, alpha, dark, tint);
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
  }

  function finalizeFrame(dots, lines, rMin) {
    rMin = rMin || 0.3;
    const visible = [];
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      if ((d.a != null ? d.a : 1) < 0.02) continue;
      d.r = Math.max(rMin, d.r);
      visible.push(d);
    }
    visible.sort((a, b) => a.z - b.z);
    return {
      dots: visible,
      lines: lines.filter((l) => (l.a != null ? l.a : 1) >= 0.02),
    };
  }

  function paintFrame(ctx, frame, dark, tint) {
    if (frame.lines && frame.lines.length) paintLines(ctx, frame.lines, dark, tint);
    paint(ctx, frame.dots, dark, 0.3, tint);
  }

  const COUNT_PAIRS = [
    ['latRings', 'lonDensity'],
    ['rings', 'lonDensity'],
    ['lanes', 'segs'],
  ];
  const COUNT_KEYS = ['orbitN', 'ghostN', 'nodeN', 'strandN', 'signals'];
  const ICON_DENSITY_KEYS = ['iconD'];
  const RADIUS_KEYS = [
    'rBase',
    'rDepth',
    'rActive',
    'rDot',
    'ghostR',
    'partR',
    'partRDepth',
    'nodeR',
    'nodeRDepth',
  ];

  function scaleCounts(opts, scale) {
    const out = Object.assign({}, opts);
    const done = new Set();
    const rt = Math.sqrt(scale);
    for (let i = 0; i < COUNT_PAIRS.length; i++) {
      const a = COUNT_PAIRS[i][0];
      const b = COUNT_PAIRS[i][1];
      const va = out[a];
      const vb = out[b];
      if (va != null && vb != null && !done.has(a) && !done.has(b)) {
        out[a] = Math.max(2, Math.round(va * rt));
        out[b] = Math.max(2, Math.round(vb * rt));
        done.add(a);
        done.add(b);
      }
    }
    for (let i = 0; i < COUNT_KEYS.length; i++) {
      const k = COUNT_KEYS[i];
      const v = out[k];
      if (v != null && v !== 0 && !done.has(k)) out[k] = Math.max(1, Math.round(v * scale));
    }
    for (let i = 0; i < ICON_DENSITY_KEYS.length; i++) {
      const k = ICON_DENSITY_KEYS[i];
      const v = out[k];
      if (v != null) out[k] = Math.max(0.02, v * scale);
    }
    return out;
  }

  function scaleRadii(opts, scale) {
    const out = Object.assign({}, opts);
    for (let i = 0; i < RADIUS_KEYS.length; i++) {
      const k = RADIUS_KEYS[i];
      const v = out[k];
      if (v != null) out[k] = v * scale;
    }
    out.rSizeMul = (out.rSizeMul != null ? out.rSizeMul : 1) * scale;
    return out;
  }

  const BASE_PROFILES = {
    globe: {
      latRings: 17,
      lonDensity: 44,
      rBase: 0.6,
      rDepth: 1.7,
      rBoost: 1,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
    },
    orbits: {
      orbitN: 12,
      ghostN: 40,
      ghostR: 0.9,
      ghostA: 0.5,
      particles: 3,
      partR: 1.2,
      partRDepth: 1.6,
      rsPow: 0.6,
      rMin: 0.3,
    },
    rubik: {
      latRings: 15,
      lonDensity: 40,
      moveCount: 14,
      rBase: 0.6,
      rDepth: 1.7,
      rActive: 0.3,
      inkFar: 0.62,
      inkSpan: 0.54,
      rsPow: 0.6,
      rMin: 0.3,
    },
    wave: {
      rings: 15,
      lonDensity: 40,
      rBase: 0.6,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3,
    },
    web: {
      nodeN: 30,
      thr: 0.72,
      signals: 5,
      nodeR: 1.4,
      nodeRDepth: 1.8,
      lineW: 0.8,
      rsPow: 0.6,
      rMin: 0.3,
    },
    braid: {
      strandN: 52,
      turns: 3,
      ghostN: 150,
      rBase: 1.2,
      rDepth: 1.8,
      rsPow: 0.6,
      rMin: 0.3,
    },
    ribbon: {
      lanes: 5,
      segs: 88,
      ghostN: 150,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3,
    },
    ring: {
      lanes: 5,
      segs: 88,
      ghostN: 0,
      faceOn: 1,
      rBase: 1.1,
      rDepth: 1.7,
      rsPow: 0.6,
      rMin: 0.3,
    },
    morph: {
      rDot: 0.021,
      iconD: 1,
      rMin: 0.25,
    },
  };

  const PRESETS = {
    orbits: {
      64: { speed: 1.885, count: 1, size: 1 },
      32: { speed: 2.9072, count: 0.4251, size: 1.6849 },
      20: { speed: 3.9, count: 0.238, size: 2.4 },
    },
    globe: {
      64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
      32: { speed: 2.3803, count: 0.1839, size: 1.4769, extra: { scanMul: 4.2301, dimBase: 0.45 } },
      20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } },
    },
    rubik: {
      64: { speed: 1.82, count: 0.35, size: 1.05 },
      32: { speed: 1.8964, count: 0.1537, size: 1.4951 },
      20: { speed: 1.95, count: 0.088, size: 1.9 },
    },
    wave: {
      64: { speed: 4.388, count: 0.341, size: 1 },
      32: { speed: 4.1512, count: 0.169, size: 1.3232 },
      20: { speed: 3.998, count: 0.105, size: 1.6 },
    },
    web: {
      64: { speed: 3.315, count: 1.35, size: 0.95 },
      32: { speed: 5.0104, count: 0.4942, size: 1.2571 },
      20: { speed: 6.63, count: 0.25, size: 1.52 },
    },
    braid: {
      64: { speed: 1.625, count: 0.5, size: 1 },
      32: { speed: 2.2234, count: 0.2056, size: 1.2011 },
      20: { speed: 2.75, count: 0.1125, size: 1.36 },
    },
    ribbon: {
      64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } },
      32: { speed: 2.7776, count: 0.0969, size: 0.9766, extra: { spin: 0, bandMul: 4.49, wobMul: 1 } },
      20: { speed: 3.12, count: 0.051, size: 1.073, extra: { spin: 0, bandMul: 4.94, wobMul: 1 } },
    },
    ring: {
      64: { speed: 3.24, count: 0.25, size: 0.956, extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 } },
      32: { speed: 3.5517, count: 0.0678, size: 1.31, extra: { spin: 0, bandMul: 3.8265, wobMul: 0.4751 } },
      20: { speed: 3.78, count: 0.028, size: 1.622, extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 } },
    },
    morph: {
      64: { speed: 2.405, count: 0.702, size: 0.395, extra: { spread: 1.45 } },
      32: { speed: 2.2057, count: 0.5937, size: 0.6916, extra: { spread: 1.45 } },
      20: { speed: 2.08, count: 0.53, size: 1.011, extra: { spread: 1.45 } },
    },
  };

  const STATE_TO_MODE = {
    working: 'orbits',
    searching: 'globe',
    solving: 'rubik',
    listening: 'wave',
    connecting: 'web',
    weaving: 'braid',
    composing: 'ribbon',
    breathing: 'ring',
    shaping: 'morph',
  };

  function solveCycle(time, count, slotDur, rest) {
    const cyc = 2 * count * slotDur + rest;
    const tc = time % cyc;
    const amount = new Array(count).fill(0);
    let active = -1;
    if (tc < 2 * count * slotDur) {
      const slot = Math.floor(tc / slotDur);
      const p = (tc - slot * slotDur) / slotDur;
      const cl = Math.min(1, p / 0.7);
      const ep = 1 - Math.pow(1 - cl, 3);
      if (slot < count) {
        for (let i = 0; i < slot; i++) amount[i] = 1;
        amount[slot] = ep;
        active = slot;
      } else {
        const u = 2 * count - 1 - slot;
        for (let i = 0; i < u; i++) amount[i] = 1;
        amount[u] = 1 - ep;
        active = u;
      }
    }
    return { amount: amount, active: active };
  }

  function applyMoves(pt3, moves, sc) {
    let x = pt3[0], y = pt3[1], z = pt3[2];
    let inActive = false;
    for (let i = 0; i < moves.length; i++) {
      if (sc.amount[i] <= 0) continue;
      const mv = moves[i];
      const coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
      if (coord < mv.lo || coord >= mv.hi) continue;
      if (i === sc.active) inActive = true;
      const a = mv.ang * sc.amount[i];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      if (mv.axis === 0) {
        const y2 = y * ca - z * sa;
        z = y * sa + z * ca;
        y = y2;
      } else if (mv.axis === 1) {
        const x2 = x * ca + z * sa;
        z = -x * sa + z * ca;
        x = x2;
      } else {
        const x2 = x * ca - y * sa;
        y = x * sa + y * ca;
        x = x2;
      }
    }
    return [x, y, z, inActive];
  }

  function makeMoves(count) {
    const moves = [];
    for (let i = 0; i < count; i++) {
      const axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3));
      const lo = -1 + 0.5 * Math.min(3, Math.floor(hashD(i, 5.9) * 4));
      const dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
      moves.push({ axis: axis, lo: lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
    }
    return moves;
  }

  function smoothE(x) {
    return x * x * (3 - 2 * x);
  }

  function polyPath(verts) {
    const V = verts.length;
    const L = [];
    let total = 0;
    for (let i = 0; i < V; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % V];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      L.push(l);
      total += l;
    }
    return function (f) {
      let target = f * total;
      let i = 0;
      while (target > L[i] && i < V - 1) {
        target -= L[i];
        i++;
      }
      const a = verts[i];
      const b = verts[(i + 1) % V];
      const ff = L[i] ? Math.min(1, target / L[i]) : 0;
      return [a[0] + (b[0] - a[0]) * ff, a[1] + (b[1] - a[1]) * ff];
    };
  }

  const CIRCLE = function (f) {
    const a = -Math.PI / 2 + f * 2 * Math.PI;
    return [Math.cos(a) * 0.24, Math.sin(a) * 0.24];
  };
  const TRIANGLE = polyPath([
    [0, -0.26],
    [0.24, 0.16],
    [-0.24, 0.16],
  ]);
  const SQUARE = polyPath([
    [0, -0.2],
    [0.2, -0.2],
    [0.2, 0.2],
    [-0.2, 0.2],
    [-0.2, -0.2],
  ]);
  const CYCLE = [CIRCLE, TRIANGLE, SQUARE];

  const frameOrbits = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.82;
    const pt = makeProj(t * 0.12, 0.3, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const dots = [];
    const orbitN = o.orbitN != null ? o.orbitN : 12;
    const ghostN = o.ghostN != null ? o.ghostN : 40;
    const particles = o.particles != null ? o.particles : 3;

    for (let orb = 0; orb < orbitN; orb++) {
      const h1 = hashD(orb, 1.7), h2 = hashD(orb, 5.2), h3 = hashD(orb, 8.9);
      const ro = R * (0.45 + 0.52 * h1);
      const th = h1 * 2 * Math.PI;
      const phi = Math.acos(2 * h2 - 1);
      const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
      let ux = -ny, uy = nx, uz = 0;
      const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy));
      ux /= ul; uy /= ul;
      const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
      const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

      for (let k = 0; k < ghostN; k++) {
        const a = (k / ghostN) * 2 * Math.PI;
        const res = pt(
          (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
          (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
          (uz * Math.cos(a) + vz * Math.sin(a)) * ro
        );
        const depth = (res[2] / ro + 1) / 2;
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: (o.ghostR != null ? o.ghostR : 0.9) * rs,
          white: 0.72,
          a: (o.ghostA != null ? o.ghostA : 0.5) * (0.4 + 0.6 * depth),
        });
      }
      for (let m = 0; m < particles; m++) {
        const a = t * speed + (m / particles) * 2 * Math.PI + h2 * 6;
        const res = pt(
          (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
          (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
          (uz * Math.cos(a) + vz * Math.sin(a)) * ro
        );
        const depth = (res[2] / ro + 1) / 2;
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.partR != null ? o.partR : 1.2) + (o.partRDepth != null ? o.partRDepth : 1.6) * depth) * rs,
          white: 0.3 - 0.22 * depth,
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameGlobe = function (size, t, o) {
    const spin = 0.5, cx = size / 2, cy = size / 2, radius = (size / 2) * 0.82;
    const tilt = 0.4 + 0.06 * Math.sin(t * 0.35);
    const pt = makeProj(t * spin, tilt, cx, cy, radius);
    const scan = t * (spin + (1.7 - spin) * (o.scanMul != null ? o.scanMul : 1));
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const dimBase = o.dimBase != null ? o.dimBase : 1;
    const dots = [];
    const latRings = o.latRings != null ? o.latRings : 17;
    const lonDensity = o.lonDensity != null ? o.lonDensity : 44;

    for (let li = 0; li <= latRings; li++) {
      const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const res = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
        const depth = (res[2] + 1) / 2;
        const d = angleDelta(lon + t * spin, scan);
        const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, res[2]);
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.rBase != null ? o.rBase : 0.6) + (o.rDepth != null ? o.rDepth : 1.7) * depth + (o.rBoost != null ? o.rBoost : 1) * boost) * rs,
          white: (o.inkFar != null ? o.inkFar : 0.62) - (o.inkSpan != null ? o.inkSpan : 0.54) * depth,
          a: dimBase + (1 - dimBase) * Math.min(1, boost),
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameRubik = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.82;
    const pt = makeProj(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), cx, cy, R);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const moveCount = o.moveCount != null ? o.moveCount : 14;
    const moves = makeMoves(moveCount);
    const sc = solveCycle(t, moveCount, 0.42, 1.2);
    const dots = [];
    const latRings = o.latRings != null ? o.latRings : 15;
    const lonDensity = o.lonDensity != null ? o.lonDensity : 40;

    for (let li = 0; li <= latRings; li++) {
      const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const mvRes = applyMoves([cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)], moves, sc);
        const res = pt(mvRes[0], mvRes[1], mvRes[2]);
        const depth = (res[2] + 1) / 2;
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.rBase != null ? o.rBase : 0.6) + (o.rDepth != null ? o.rDepth : 1.7) * depth + (mvRes[3] ? o.rActive != null ? o.rActive : 0.3 : 0)) * rs,
          white: (o.inkFar != null ? o.inkFar : 0.62) - (o.inkSpan != null ? o.inkSpan : 0.54) * depth - (mvRes[3] ? 0.14 : 0),
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameWave = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.874;
    const pt = makeProj(t * 0.18, 0.38, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const dots = [];
    const rings = o.rings != null ? o.rings : 15;
    const lonDensity = o.lonDensity != null ? o.lonDensity : 40;

    for (let ri = 0; ri <= rings; ri++) {
      const lat = -Math.PI / 2 + (ri / rings) * Math.PI;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      const w = 0.62 * Math.sin(t * 2.1 - ri * 0.52) + 0.38 * Math.sin(t * 1.27 + ri * 0.83);
      const rr = R * (0.88 + 0.105 * w);
      const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (let lj = 0; lj < lonCount; lj++) {
        const lon = (lj / lonCount) * 2 * Math.PI;
        const res = pt(cosLat * Math.cos(lon) * rr, sinLat * rr, cosLat * Math.sin(lon) * rr);
        const depth = (res[2] / R + 1) / 2;
        const crest = Math.max(0, w);
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.rBase != null ? o.rBase : 0.6) + (o.rDepth != null ? o.rDepth : 1.7) * depth) * (1 + 0.4 * crest) * rs,
          white: 0.66 - 0.56 * depth - 0.1 * crest,
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameBraid = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.76;
    const pt = makeProj(t * 0.4, 0.3, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const dots = [];
    const ghostN = o.ghostN != null ? o.ghostN : 150;

    for (let i = 0; i < ghostN; i++) {
      const d = fibDir(i, ghostN);
      const res = pt(d[0] * R, d[1] * R, d[2] * R);
      const depth = (res[2] / R + 1) / 2;
      dots.push({ x: res[0], y: res[1], z: res[2], r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }
    const strandN = o.strandN != null ? o.strandN : 52;
    const turns = o.turns != null ? o.turns : 3;

    for (let s = 0; s < 3; s++) {
      const phase = (s / 3) * 2 * Math.PI;
      for (let i = 0; i < strandN; i++) {
        const u = (frac(i / strandN + t * 0.045) * 2 - 1) * 0.96;
        const surf = Math.sqrt(Math.max(0, 1 - u * u));
        const endFade = Math.min(1, (1 - Math.abs(u)) / 0.1);
        const a = u * Math.PI * turns + phase;
        const weave = 1 + 0.075 * Math.sin(u * Math.PI * turns * 2 + phase * 2 + t * 0.8);
        const rr = surf * R * weave;
        const res = pt(Math.cos(a) * rr, u * R * weave, Math.sin(a) * rr);
        const depth = (res[2] / R + 1) / 2;
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.rBase != null ? o.rBase : 1.2) + (o.rDepth != null ? o.rDepth : 1.8) * depth) * rs,
          white: 0.55 - 0.45 * depth,
          a: endFade * (0.45 + 0.55 * depth),
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameRibbon = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.78;
    const spin = o.spin != null ? o.spin : 1;
    const camTilt = 0.3;
    const pt = makeProj(t * 0.1 * spin, camTilt, cx, cy, 1);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const dots = [];
    const ghostN = o.ghostN != null ? o.ghostN : 150;

    for (let i = 0; i < ghostN; i++) {
      const d = fibDir(i, ghostN);
      const res = pt(d[0] * R, d[1] * R, d[2] * R);
      const depth = (res[2] / R + 1) / 2;
      dots.push({ x: res[0], y: res[1], z: res[2], r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
    }

    const ya = t * 0.24 * spin;
    const ta = o.faceOn ? -camTilt : 0.55 + 0.3 * Math.sin(t * 0.18) * spin;
    const ux = Math.cos(ya), uy = 0, uz = Math.sin(ya);
    const vx = -uz * Math.sin(ta), vy = Math.cos(ta), vz = ux * Math.sin(ta);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const wobAmp = 0.23 * (o.wobMul != null ? o.wobMul : 1);
    const baseR = o.faceOn ? R / (1 + 0.85 * wobAmp) : R;
    const baseLanes = o.lanes != null ? o.lanes : 5;
    const segs = o.segs != null ? o.segs : 88;
    const lanes = Math.max(1, Math.round(baseLanes * (o.bandMul != null ? o.bandMul : 1)));

    for (let w = 0; w < lanes; w++) {
      const laneOff = (w - (lanes - 1) / 2) * 0.075;
      const edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * 2 * Math.PI;
        const wob = (0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1)) * (o.wobMul != null ? o.wobMul : 1);
        const radial = o.faceOn ? 1 + wob : 1;
        const off = o.faceOn ? laneOff : laneOff + wob;
        const x = ux * Math.cos(a) + vx * Math.sin(a) + nx * off;
        const y = uy * Math.cos(a) + vy * Math.sin(a) + ny * off;
        const z = uz * Math.cos(a) + vz * Math.sin(a) + nz * off;
        const l = Math.sqrt(x * x + y * y + z * z);
        const rr = baseR * radial;
        const res = pt((x / l) * rr, (y / l) * rr, (z / l) * rr);
        const depth = (res[2] / R + 1) / 2;
        dots.push({
          x: res[0], y: res[1], z: res[2],
          r: ((o.rBase != null ? o.rBase : 1.1) + (o.rDepth != null ? o.rDepth : 1.7) * depth) * (1 - 0.25 * edge) * rs,
          white: 0.52 - 0.44 * depth + 0.18 * edge,
          a: 0.4 + 0.6 * depth,
        });
      }
    }
    return finalizeFrame(dots, [], o.rMin);
  };

  const frameWeb = function (size, t, o) {
    const cx = size / 2, cy = size / 2, R = (size / 2) * 0.8 * (o.spread != null ? o.spread : 1);
    const pt = makeProj(t * 0.12, 0.32, cx, cy, R);
    const rs = radiusScale(size, o.rsPow != null ? o.rsPow : 0.6);
    const nodeN = o.nodeN != null ? o.nodeN : 30;
    const thr = o.thr != null ? o.thr : 0.72;
    const nodeR = o.nodeR != null ? o.nodeR : 1.4;
    const nodeRDepth = o.nodeRDepth != null ? o.nodeRDepth : 1.8;
    const nodes = [];

    for (let i = 0; i < nodeN; i++) {
      const d = fibDir(i, nodeN);
      const x = d[0] + 0.3 * (vnoise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
      const y = d[1] + 0.3 * (vnoise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
      const z = d[2] + 0.3 * (vnoise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
      const l = Math.sqrt(x * x + y * y + z * z);
      nodes.push([x / l, y / l, z / l]);
    }

    const lines = [];
    const dots = [];

    for (let i = 0; i < nodeN; i++) {
      for (let j = i + 1; j < nodeN; j++) {
        const dx = nodes[i][0] - nodes[j][0], dy = nodes[i][1] - nodes[j][1], dz = nodes[i][2] - nodes[j][2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= thr) continue;
        const p1 = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
        const p2 = pt(nodes[j][0], nodes[j][1], nodes[j][2]);
        const depth = ((p1[2] + p2[2]) / 2 + 1) / 2;
        lines.push({
          x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
          white: 0.42,
          a: (1 - dist / thr) * (0.3 + 0.55 * depth),
          w: Math.max(0.6, (o.lineW != null ? o.lineW : 0.8) * rs),
        });
      }
    }

    for (let i = 0; i < nodeN; i++) {
      const res = pt(nodes[i][0], nodes[i][1], nodes[i][2]);
      const depth = (res[2] + 1) / 2;
      const pulse = 1 + 0.25 * Math.sin(t * 1.4 + i * 2.7);
      dots.push({
        x: res[0], y: res[1], z: res[2],
        r: (nodeR + nodeRDepth * depth) * pulse * rs,
        white: 0.55 - 0.45 * depth,
      });
    }

    const signals = o.signals != null ? o.signals : 5;
    for (let s = 0; s < signals; s++) {
      const seg = Math.floor(t * 0.55 + s * 7.31);
      const a = Math.floor(hashD(seg, s * 3.1 + 1.7) * nodeN);
      const b = Math.floor(hashD(seg, s * 5.7 + 4.2) * nodeN);
      if (a === b) continue;
      const f = frac(t * 0.55 + s * 7.31);
      const x = lerp(nodes[a][0], nodes[b][0], f);
      const y = lerp(nodes[a][1], nodes[b][1], f);
      const z = lerp(nodes[a][2], nodes[b][2], f);
      const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
      const res = pt(x / l, y / l, z / l);
      const depth = (res[2] + 1) / 2;
      dots.push({
        x: res[0], y: res[1], z: res[2],
        r: (nodeR * 1.5 + nodeRDepth * depth) * rs,
        white: 0.05,
        a: 0.5 + 0.5 * depth,
      });
    }

    return finalizeFrame(dots, lines, o.rMin);
  };

  const frameMorph = function (size, t, o) {
    const HOLD = 1.4, MORPH = 0.9, SEG = HOLD + MORPH;
    const K = CYCLE.length;
    const tc = t % (SEG * K);
    const held = o.shape != null && o.shape >= 0 && o.shape < K ? Math.floor(o.shape) : -1;
    const k = held >= 0 ? held : Math.floor(tc / SEG);
    const local = held >= 0 ? t % SEG : tc - k * SEG;
    const m = held >= 0 ? 0 : local > HOLD ? smoothE((local - HOLD) / MORPH) : 0;
    const sprd = o.spread != null ? o.spread : 1;
    const pA = CYCLE[k];
    const pB = held >= 0 ? pA : CYCLE[(k + 1) % K];
    const M = 160;
    const pts = [];

    for (let i = 0; i < M; i++) {
      const f = i / M;
      const a = pA(f), b = pB(f);
      pts.push([(a[0] + (b[0] - a[0]) * m) * sprd, (a[1] + (b[1] - a[1]) * m) * sprd]);
    }
    const L = [];
    let total = 0;
    for (let i = 0; i < M; i++) {
      const a = pts[i], b = pts[(i + 1) % M];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      L.push(l);
      total += l;
    }

    const n = Math.max(6, Math.round(34 * (o.iconD != null ? o.iconD : 1)));
    const re = (o.rDot != null ? o.rDot : 0.021) * 1.35 * sprd;
    const pulse = 1 + 0.02 * Math.sin(local * 3.1);
    const dots = [];
    const c2 = size / 2;
    let seg = 0, acc = 0;

    for (let k2 = 0; k2 < n; k2++) {
      const target = (k2 / n) * total;
      while (acc + L[seg] < target && seg < M - 1) {
        acc += L[seg];
        seg++;
      }
      const a = pts[seg], b = pts[(seg + 1) % M];
      const f = L[seg] ? Math.min(1, (target - acc) / L[seg]) : 0;
      const x = (a[0] + (b[0] - a[0]) * f) * pulse;
      const y = (a[1] + (b[1] - a[1]) * f) * pulse;
      dots.push({
        x: c2 + x * size,
        y: c2 + y * size,
        z: 0,
        r: Math.max(0.35, re * size),
        white: 0.1,
      });
    }

    return finalizeFrame(dots, [], o.rMin);
  };

  const MODE_FRAMES = {
    orbits: frameOrbits,
    globe: frameGlobe,
    rubik: frameRubik,
    wave: frameWave,
    web: frameWeb,
    braid: frameBraid,
    ribbon: frameRibbon,
    ring: frameRibbon,
    morph: frameMorph,
  };

  const presetCache = new Map();
  function resolvePreset(state, size) {
    const key = state + '-' + size;
    const hit = presetCache.get(key);
    if (hit) return hit;
    const mode = STATE_TO_MODE[state] || 'orbits';
    const presetsForMode = PRESETS[mode];
    const preset = presetsForMode[size] || presetsForMode[64] || presetsForMode[20];
    let opts = Object.assign({}, BASE_PROFILES[mode]);
    if (preset.count !== 1) opts = scaleCounts(opts, preset.count);
    if (preset.size !== 1) opts = scaleRadii(opts, preset.size);
    if (preset.extra) opts = Object.assign(opts, preset.extra);
    const resolved = { mode: mode, speed: preset.speed, opts: opts };
    presetCache.set(key, resolved);
    return resolved;
  }

  const ORB_LABELS = {
    working: 'Working…',
    searching: 'Searching…',
    solving: 'Solving…',
    listening: 'Listening…',
    connecting: 'Connecting…',
    weaving: 'Weaving…',
    composing: 'Composing…',
    breathing: 'Standing by…',
    shaping: 'Sanitizing…',
  };

  function parseTint(color) {
    if (!color) return undefined;
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex && hex[1]) {
      let h = hex[1];
      if (h.length === 3) h = h.replace(/./g, (c) => c + c);
      const n = parseInt(h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    const fn = color.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (fn && fn[1] && fn[2] && fn[3]) {
      return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
    }
    return undefined;
  }

  function resolveDarkTheme(theme, el) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    let curr = el;
    while (curr) {
      const attr = curr.getAttribute('data-theme');
      if (attr === 'dark') return true;
      if (attr === 'light') return false;
      if (curr.classList && curr.classList.contains('dark')) return true;
      if (curr.classList && curr.classList.contains('light')) return false;
      curr = curr.parentElement;
    }
    return typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  }

  function createThinkingOrb(options) {
    options = options || {};
    const canvas = document.createElement('canvas');
    canvas.classList.add('thinking-orb-canvas');
    canvas.setAttribute('role', 'img');

    let state = options.state || 'working';
    let size = options.size || 64;
    let theme = options.theme || 'auto';
    let speed = options.speed || 1;
    let paused = !!options.paused;
    let color = options.color;
    let ariaLabel = options.ariaLabel;

    canvas.setAttribute('aria-label', ariaLabel || ORB_LABELS[state] || 'Loading…');

    let rafId = 0;
    let running = false;
    let isVisible = true;
    let isDestroyed = false;

    const ctx = canvas.getContext('2d');

    function updateAria() {
      canvas.setAttribute('aria-label', ariaLabel || ORB_LABELS[state] || 'Loading…');
    }

    function resize() {
      const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
    }

    function renderFrame(timeSeconds) {
      if (!ctx || isDestroyed) return;
      const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
      const dark = resolveDarkTheme(theme, canvas);
      const tint = parseTint(color);
      const resolved = resolvePreset(state, size);
      const frameFn = MODE_FRAMES[resolved.mode] || frameOrbits;
      const effSpeed = resolved.speed * speed;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      paintFrame(ctx, frameFn(size, timeSeconds * effSpeed, resolved.opts), dark, tint);
    }

    function tick() {
      if (!running || paused || isDestroyed) return;
      renderFrame(performance.now() / 1000);
      rafId = requestAnimationFrame(tick);
    }

    function start() {
      if (running || paused || isDestroyed) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    const prefersReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    resize();

    if (prefersReduced) {
      renderFrame(0.6);
    } else {
      renderFrame(performance.now() / 1000);
      start();
    }

    let io = null;
    if (!prefersReduced && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(function (entries) {
        if (!entries[0]) return;
        isVisible = entries[0].isIntersecting;
        if (isVisible && document.visibilityState !== 'hidden') {
          start();
        } else {
          stop();
        }
      });
      io.observe(canvas);
    }

    const onVisChange = function () {
      if (document.visibilityState === 'hidden') {
        stop();
      } else if (isVisible && !paused && !prefersReduced) {
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return {
      canvas: canvas,
      getState: function () { return state; },
      setState: function (nextState) {
        if (state === nextState) return;
        state = nextState;
        updateAria();
        if (prefersReduced) renderFrame(0.6);
      },
      getSize: function () { return size; },
      setSize: function (nextSize) {
        if (size === nextSize) return;
        size = nextSize;
        resize();
        if (prefersReduced) renderFrame(0.6);
      },
      setPaused: function (nextPaused) {
        paused = nextPaused;
        if (paused) stop();
        else if (isVisible && !prefersReduced) start();
      },
      destroy: function () {
        isDestroyed = true;
        stop();
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVisChange);
      },
    };
  }

  class ThinkingOrbElement extends HTMLElement {
    static get observedAttributes() {
      return ['state', 'size', 'theme', 'speed', 'color', 'paused'];
    }

    connectedCallback() {
      if (this.orbInstance) return;
      const state = this.getAttribute('state') || 'working';
      const size = parseInt(this.getAttribute('size') || '64', 10) || 64;
      const theme = this.getAttribute('theme') || 'auto';
      const speed = parseFloat(this.getAttribute('speed') || '1') || 1;
      const color = this.getAttribute('color') || undefined;
      const paused = this.hasAttribute('paused');

      this.orbInstance = createThinkingOrb({
        state: state,
        size: size,
        theme: theme,
        speed: speed,
        color: color,
        paused: paused,
      });

      this.replaceChildren(this.orbInstance.canvas);
    }

    disconnectedCallback() {
      if (this.orbInstance) {
        this.orbInstance.destroy();
        this.orbInstance = null;
      }
    }

    attributeChangedCallback(name, _oldVal, newVal) {
      if (!this.orbInstance) return;
      if (name === 'state' && newVal) {
        this.orbInstance.setState(newVal);
      } else if (name === 'size' && newVal) {
        this.orbInstance.setSize(parseInt(newVal, 10) || 64);
      } else if (name === 'paused') {
        this.orbInstance.setPaused(newVal !== null);
      }
    }

    get state() {
      return this.orbInstance ? this.orbInstance.getState() : (this.getAttribute('state') || 'working');
    }

    set state(value) {
      this.setAttribute('state', value);
    }
  }

  if (typeof customElements !== 'undefined' && !customElements.get('thinking-orb')) {
    customElements.define('thinking-orb', ThinkingOrbElement);
  }

  function agentPhaseToOrbState(phase) {
    switch (phase) {
      case 'idle': return 'breathing';
      case 'capturing': return 'searching';
      case 'sanitizing': return 'shaping';
      case 'reasoning': return 'solving';
      case 'executing': return 'working';
      case 'done': return 'breathing';
      case 'blocked': return 'listening';
      case 'error': return 'shaping';
      default: return 'breathing';
    }
  }

  global.ThinkingOrbs = {
    createThinkingOrb: createThinkingOrb,
    agentPhaseToOrbState: agentPhaseToOrbState,
    resolvePreset: resolvePreset,
    paintFrame: paintFrame,
    MODE_FRAMES: MODE_FRAMES,
    STATE_TO_MODE: STATE_TO_MODE,
    ORB_LABELS: ORB_LABELS,
    ORB_STATES: [
      'working',
      'searching',
      'solving',
      'listening',
      'connecting',
      'weaving',
      'composing',
      'breathing',
      'shaping',
    ],
  };
})(typeof window !== 'undefined' ? window : globalThis);
