/* Écran de chargement d'Atelier Nuages 3D (même esprit que celui de Model Educ Studio).
 *
 * Script classique, HORS bundle : il s'exécute avant l'application et affiche l'écran tout de suite.
 * Animation : un scanner pose ses points sur une salle ; la part de nuage visible = le pourcentage de chargement.
 *
 * Le pourcentage suit de VRAIES étapes, annoncées par l'application via window.__splash.milestone(nom) :
 *   html 10 → script 40 (module chargé) → app 65 (interface construite) → gpu 82 (premier rendu 3D)
 *   → workers 96 (Workers et décodeur LAZ préchauffés) → ready 100.
 * Un temps minimal d'affichage (2,8 s à la première visite, 0,9 s ensuite) laisse lire la licence.
 * Cliquer (ou Entrée / Échap) passe l'écran dès que l'application est prête.
 */
(function () {
  'use strict';
  var root = document.getElementById('splash');
  if (!root) return;
  root.classList.add('on');

  var canvas = root.querySelector('canvas');
  var ctx = canvas.getContext('2d');
  var pctEl = root.querySelector('[data-pct]');
  var bar = root.querySelector('.bar');
  var barFill = bar.querySelector('i');
  var hint = root.querySelector('.skip');
  var licBtn = root.querySelector('.lic-btn');
  var licDetail = root.querySelector('#lic-detail');
  var stateEl = root.querySelector('.state');
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var seen = false;
  try { seen = sessionStorage.getItem('nuages3d-splash') === '1'; } catch (e) { /* stockage indisponible : on affiche en entier */ }
  var MIN_MS = reduce ? 600 : seen ? 900 : 2800;
  var MILESTONES = { html: 10, script: 40, app: 65, gpu: 82, workers: 96, ready: 100 };

  var S = {
    target: MILESTONES.html,
    hold: false, // débogage : empêche la fermeture
    milestone: function (name) {
      var v = MILESTONES[name];
      if (v && v > S.target) S.target = v;
    },
    fail: function (msg) {
      failed = true;
      stateEl.innerHTML = '';
      var m = document.createElement('span');
      m.className = 'err';
      m.textContent = 'Le chargement a échoué : ' + msg + ' — actualisez la page.';
      stateEl.appendChild(m);
    },
  };
  window.__splash = S;
  var failed = false, finished = false, holdLicence = false;

  // ------------------------------------------------------------------ scène : une salle « scannée »
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var R = mulberry32(11);
  var SX = -0.25, SY = 0.05, SZ = 0.62; // tête du scanner
  var H = 1.1; // hauteur des murs
  var surfaces = [
    { w: 6.0, f: function () { return [-1.5 + R() * 3, -1 + R() * 2, 0]; } },
    { w: 2.4, f: function () { return [-1.5, -1 + R() * 2, R() * H]; } },
    { w: 2.4, f: function () { return [1.5, -1 + R() * 2, R() * H]; } },
    { w: 3.3, f: function () { return [-1.5 + R() * 3, -1, R() * H]; } },
    { w: 3.3, f: function () { return [-1.5 + R() * 3, 1, R() * H]; } },
    { w: 0.9, f: function () { return [0.45 + R() * 0.6, -0.3 + R() * 0.6, 0.45]; } }, // plateau de table
    { w: 1.1, f: function () { // flancs de table
      var s = R() * 2.4, z = R() * 0.45;
      if (s < 0.6) return [0.45, -0.3 + s, z];
      if (s < 1.2) return [1.05, -0.3 + (s - 0.6), z];
      if (s < 1.8) return [0.45 + (s - 1.2), -0.3, z];
      return [0.45 + (s - 1.8), 0.3, z];
    } },
    { w: 1.3, f: function () { var a = R() * 6.2832; return [-0.9 + 0.13 * Math.cos(a), -0.55 + 0.13 * Math.sin(a), R() * H]; } }, // poteau
  ];
  var totalW = 0, i;
  for (i = 0; i < surfaces.length; i++) totalW += surfaces[i].w;
  var N = 6500, pts = [];
  for (i = 0; i < N; i++) {
    var r = R() * totalW, k = 0;
    while (k < surfaces.length - 1 && r > surfaces[k].w) { r -= surfaces[k].w; k++; }
    var p = surfaces[k].f();
    var az = Math.atan2(p[1] - SY, p[0] - SX);
    if (az < 0) az += 6.2832;
    pts.push({ x: p[0], y: p[1], z: p[2], az: az, b: Math.min(5, Math.floor((p[2] / H) * 5.99)) });
  }
  pts.sort(function (a, b) { return a.az - b.az; });
  var buckets = [[], [], [], [], [], []];
  for (i = 0; i < N; i++) { pts[i].rank = i; buckets[pts[i].b].push(pts[i]); }
  var COLORS = ['rgba(176,92,32,', 'rgba(198,110,40,', 'rgba(220,134,58,', 'rgba(234,158,84,', 'rgba(244,184,116,', 'rgba(252,214,160,'];

  // ------------------------------------------------------------------ rendu 2D avec projection perspective
  var dpr = 1, W = 0, Hh = 0;
  function resize() {
    W = canvas.clientWidth; Hh = canvas.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(Hh * dpr));
  }
  var PITCH = 0.66, cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  var ang = 0.55, SC = 100, CX = 0, CY = 0;
  function proj(x, y, z) {
    var c = Math.cos(ang), s = Math.sin(ang);
    var xr = x * c - y * s, yr = x * s + y * c;
    var depth = yr * cp - z * sp; // plus grand = plus loin
    var f = 1 / (1 + depth * 0.09);
    return [CX + xr * f * SC, CY - (yr * sp + z * cp) * f * SC, f];
  }
  function line(a, b) { var u = proj(a[0], a[1], a[2]), v = proj(b[0], b[1], b[2]); ctx.moveTo(u[0], u[1]); ctx.lineTo(v[0], v[1]); }

  function draw(k) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    // la scène (≈ 7 unités de large, 4,1 de haut) doit tenir dans le canevas quelle que soit sa forme
    SC = Math.min(W / 7.4, Hh / 4.35); CX = W / 2; CY = Hh / 2 - 0.15 * SC;
    // plan de sol (grille)
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,134,170,0.22)';
    ctx.beginPath();
    for (var g = -2; g <= 2.001; g += 0.25) { line([g, -2, 0], [g, 2, 0]); line([-2, g, 0], [2, g, 0]); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,164,200,0.55)';
    ctx.beginPath();
    line([-2, -2, 0], [2, -2, 0]); line([2, -2, 0], [2, 2, 0]); line([2, 2, 0], [-2, 2, 0]); line([-2, 2, 0], [-2, -2, 0]);
    ctx.stroke();
    // points déjà acquis (rangés par hauteur pour ne changer de couleur que 6 fois)
    var px = Math.max(1.3, W / 330);
    for (var b = 0; b < 6; b++) {
      ctx.fillStyle = COLORS[b] + '0.85)';
      var arr = buckets[b];
      for (var j = 0; j < arr.length; j++) {
        var q = arr[j];
        if (q.rank >= k) break;
        var u = proj(q.x, q.y, q.z);
        var s = px * (0.7 + u[2] * 0.5);
        ctx.fillRect(u[0] - s / 2, u[1] - s / 2, s, s);
      }
    }
    // balayage en cours : points les plus récents en clair + rayons laser
    var from = Math.max(0, k - 110);
    ctx.fillStyle = 'rgba(255,243,214,0.95)';
    for (var m = from; m < k && m < N; m++) {
      var t = pts[m], v = proj(t.x, t.y, t.z), s2 = px * 1.5;
      ctx.fillRect(v[0] - s2 / 2, v[1] - s2 / 2, s2, s2);
    }
    var head = proj(SX, SY, SZ), foot = proj(SX, SY, 0);
    if (k > 0 && k < N) {
      ctx.strokeStyle = 'rgba(255,226,180,0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var n = from; n < k; n += 12) { var e = proj(pts[n].x, pts[n].y, pts[n].z); ctx.moveTo(head[0], head[1]); ctx.lineTo(e[0], e[1]); }
      ctx.stroke();
    }
    // scanner : trépied + tête conique orange (comme la buse de Model Educ Studio)
    ctx.strokeStyle = 'rgba(190,200,225,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(foot[0], foot[1]); ctx.lineTo(head[0], head[1] + 4); ctx.stroke();
    ctx.fillStyle = '#e89c4f';
    ctx.beginPath(); ctx.moveTo(head[0] - px * 3.4, head[1] - px * 9); ctx.lineTo(head[0] + px * 3.4, head[1] - px * 9); ctx.lineTo(head[0], head[1] + 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f6e3c0';
    ctx.beginPath(); ctx.arc(head[0], head[1] + 2, px * 1.8, 0, 6.2832); ctx.fill();
  }

  // ------------------------------------------------------------------ progression
  var t0 = performance.now(), last = t0, pct = 0, startAng = 0.55;
  function show(p) {
    var v = Math.round(p);
    pctEl.textContent = v + ' %';
    barFill.style.width = p.toFixed(1) + '%';
    bar.setAttribute('aria-valuenow', String(v));
  }
  function finish() {
    if (finished) return;
    finished = true;
    try { sessionStorage.setItem('nuages3d-splash', '1'); } catch (e) { /* sans importance */ }
    root.classList.add('out');
    setTimeout(function () {
      root.remove();
      window.__splash = S;
      window.dispatchEvent(new Event('splash-done'));
    }, 520);
  }
  function step(now) {
    if (finished || failed) return;
    var dt = now - last; last = now;
    var cap = MIN_MS > 0 ? ((now - t0) / MIN_MS) * 100 : 100;
    var goal = Math.min(S.target, cap);
    if (goal > pct) pct = Math.min(goal, pct + Math.max((goal - pct) * 0.1, dt * 0.012));
    show(pct);
    ang = startAng + (now - t0) * 0.00021;
    draw(reduce ? N : Math.floor((pct / 100) * N));
    var ready = S.target >= 100;
    if (ready && pct >= 99.5 && !S.hold) {
      if (holdLicence) { hint.hidden = false; } else { show(100); draw(N); finish(); return; }
    }
    if (now - t0 > 20000 && !ready) stateEl.setAttribute('data-slow', '1');
    if (reduce) setTimeout(function () { step(performance.now()); }, 120); else requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ interactions
  function skip() { if (S.target >= 100 && !S.hold) { MIN_MS = 0; holdLicence = false; } }
  root.addEventListener('click', skip);
  window.addEventListener('keydown', function (e) { if (!finished && (e.key === 'Escape' || e.key === 'Enter')) skip(); });
  root.querySelector('.licence').addEventListener('click', function (e) { e.stopPropagation(); });
  licBtn.addEventListener('click', function () {
    var open = licDetail.hidden;
    licDetail.hidden = !open;
    holdLicence = open; // on laisse le temps de lire : l'écran reste jusqu'à un clic
    licBtn.setAttribute('aria-expanded', String(open));
    licBtn.textContent = open ? 'Fermer l’explication ‹' : 'Que veut dire cette licence ? ›';
    if (!open) { holdLicence = false; }
  });
  window.addEventListener('resize', function () { resize(); });
  document.addEventListener('DOMContentLoaded', function () { S.milestone('html'); });

  resize();
  draw(0);
  requestAnimationFrame(step);
})();
