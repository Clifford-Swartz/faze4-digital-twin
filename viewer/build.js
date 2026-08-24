// J1 Construction Twin: parts start unboxed on the floor and fly to their
// assembled poses step by step, mirroring the real bench build.
// Data: data/build_j1.json (poses from viewer_transforms/rebuild_parts,
// steps adapted from FAZE4 Assembly instructions 3.1 p.61-77).

import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';
import { STLLoader } from './lib/STLLoader.js';

const DEG = Math.PI / 180;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16181d);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
camera.up.set(0, 0, 1);
camera.position.set(700, -1900, 950);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-350, -550, 80);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 40;
controls.maxDistance = 6000;
// delta-proportional zoom (same fix as the main viewer)
controls.enableZoom = false;
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  let dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey) dy *= 5;
  const f = Math.exp(dy * 0.0012);
  const off = camera.position.clone().sub(controls.target);
  off.setLength(Math.min(Math.max(off.length() * f, controls.minDistance), controls.maxDistance));
  camera.position.copy(controls.target).add(off);
}, { passive: false });

scene.add(new THREE.HemisphereLight(0x99aabb, 0x333844, 0.6));
const dl = new THREE.DirectionalLight(0xffffff, 1.9);
dl.position.set(500, -700, 900);
scene.add(dl);
const dl2 = new THREE.DirectionalLight(0x88aaff, 0.6);
dl2.position.set(-600, 400, 300);
scene.add(dl2);
const grid = new THREE.GridHelper(3600, 72, 0x3a4150, 0x262b34);
grid.rotation.x = Math.PI / 2;
grid.position.set(-350, -600, 0);
scene.add(grid);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function eulerZYX(r) { return new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX'); }

const COLORS = { stock: 0x7fa6d9, rebuild: 0xff7043, hardware: 0xc8ccd4,
                 belt: 0x3c3c42, board: 0x2e8b57, screw: 0x8a8f99 };
// group palette mirrors the main assembly viewer
const GROUPC = { base: 0x7fa6d9, j2: 0xd9a06b, j3: 0x8fc98f, j4: 0xc98fc0,
                 j5_forearm: 0xd9d06b, j6: 0x6bc9c9,
                 rebuild_j1: 0xff7043, rebuild_gripper: 0xe0567a };
const METAL = { roughness: 0.35, metalness: 0.85 };
const loader = new STLLoader();
const entries = [];      // {key,label,mesh,assembled:{pos,quat},floor:{pos,quat},anim}
let data = null;
let step = 0;
const LSKEY = 'j1build_done';
let done = new Set(JSON.parse(localStorage.getItem(LSKEY) || '[]'));

const geomCache = new Map();
function load(url) {
  if (!geomCache.has(url)) {
    geomCache.set(url, new Promise((res) => loader.load(encodeURI(url), g => res(g), undefined, () => res(null))));
  }
  return geomCache.get(url);
}

async function main() {
  data = await fetch('./data/build_j1.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
  // step index per part key
  const stepOf = {};
  data.steps.forEach((s, i) => s.parts.forEach(k => { stepOf[k] = i; }));

  for (const p of data.parts) {
    const geom = await load(p.file);
    if (!geom) { console.warn('missing', p.file); continue; }
    geom.computeBoundingBox();
    const special = ['hardware', 'belt', 'board'].includes(p.kind);
    const mat = new THREE.MeshStandardMaterial({
      color: special ? COLORS[p.kind] : (GROUPC[p.group] || COLORS[p.kind] || 0xaaaaaa),
      roughness: p.kind === 'hardware' ? METAL.roughness : 0.75,
      metalness: p.kind === 'hardware' ? METAL.metalness : 0.1,
    });
    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    const aq = new THREE.Quaternion().setFromEuler(eulerZYX(p.assembled.rotate_deg));
    entries.push({
      key: p.key, label: p.label, mesh, group: p.group || null,
      bb: geom.boundingBox.clone(),
      step: stepOf[p.key] ?? 999,
      A: { pos: new THREE.Vector3().fromArray(p.assembled.translate), quat: aq },
      F: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },  // set by layout
      t: 1, from: null, to: null, t0: 0,
    });
  }
  layoutFloor();
  applyStep(0, true);
  buildChecklist();
  updateUI();
  window.buildDebug = { entries, camera, controls, applyStep, THREE };
}

function rotatedBB(e) {
  // bbox of the part under its ASSEMBLED rotation (staging keeps attitude)
  if (e.rb) return e.rb;
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? e.bb.max.x : e.bb.min.x,
          i & 2 ? e.bb.max.y : e.bb.min.y,
          i & 4 ? e.bb.max.z : e.bb.min.z).applyQuaternion(e.A.quat);
    min.min(v); max.max(v);
  }
  e.rb = { min, max };
  return e.rb;
}

function packZone(list, x0, y0, maxW) {
  // grid-pack a list into a zone starting at (x0,y0); returns bbox.
  // parts keep their assembled attitude - no upside-down staging.
  const sorted = [...list].sort((a, b) => {
    const ra = rotatedBB(a), rb = rotatedBB(b);
    return (rb.max.x - rb.min.x) * (rb.max.y - rb.min.y) -
           (ra.max.x - ra.min.x) * (ra.max.y - ra.min.y);
  });
  let x = x0, y = y0, rowH = 0, maxX = x0, maxY = y0;
  for (const e of sorted) {
    const r = rotatedBB(e);
    const w = r.max.x - r.min.x, d = r.max.y - r.min.y;
    if (x + w > x0 + maxW && x > x0) { x = x0; y += rowH + 22; rowH = 0; }
    e.F.pos.set(x - r.min.x, y - r.min.y, -r.min.z + 0.2);
    e.F.quat.copy(e.A.quat);
    x += w + 22;
    rowH = Math.max(rowH, d);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y + d);
  }
  return { x0, y0, x1: maxX, y1: maxY };
}

function blob(bbox, color) {
  const w = (bbox.x1 - bbox.x0) + 60, d = (bbox.y1 - bbox.y0) + 60;
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1.6, 48),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.32,
                                     roughness: 0.9, depthWrite: false }));
  m.rotation.x = Math.PI / 2;
  // scale is local-space: x/z are the disc radii, y is the cylinder axis
  m.scale.set(w / 2, 1, d / 2);
  m.position.set((bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2, 0.8);
  m.raycast = () => {};   // never eats part clicks
  scene.add(m);
}

function layoutFloor() {
  const firstUpper = data.steps.findIndex(s => s.title.startsWith('J2:'));
  const placed = new Set();

  // J1 build inventory: everything staged for the steps before the J2 phase
  const j1inv = entries.filter(e => e.step < firstUpper);
  blob(packZone(j1inv, -1080, -620, 640), GROUPC.base);
  j1inv.forEach(e => placed.add(e));

  // upper joints: one colored zone each (saddle shells join the j2 zone)
  const order = ['j2', 'j3', 'j4', 'j5_forearm', 'j6', 'rebuild_gripper'];
  let zx = -2050;
  for (const gname of order) {
    const list = entries.filter(e => !placed.has(e) &&
      (e.group === gname || (gname === 'j2' && e.group === 'base')));
    if (!list.length) continue;
    const bbox = packZone(list, zx, -1420, 400);
    blob(bbox, GROUPC[gname]);
    list.forEach(e => placed.add(e));
    zx = bbox.x1 + 110;
  }

  // catch-all (future electronics etc.) - neutral gray pile
  const rest = entries.filter(e => !placed.has(e));
  if (rest.length) blob(packZone(rest, zx, -1420, 400), 0x8b93a3);
}

function applyStep(s, snap) {
  step = Math.max(0, Math.min(s, data.steps.length - 1));
  for (const e of entries) {
    const target = (e.step <= step) ? e.A : e.F;
    if (snap) {
      e.mesh.position.copy(target.pos);
      e.mesh.quaternion.copy(target.quat);
      e.t = 1;
    } else if (e.mesh.position.distanceTo(target.pos) > 0.01 ||
               e.mesh.quaternion.angleTo(target.quat) > 0.001) {
      e.from = { pos: e.mesh.position.clone(), quat: e.mesh.quaternion.clone() };
      e.to = target;
      e.t = 0;
      e.t0 = performance.now() + Math.random() * 250;   // slight stagger
    }
  }
  updateUI();
}

function updateUI() {
  const s = data.steps[step];
  document.getElementById('steptitle').textContent = `${step}. ${s.title}`;
  document.getElementById('steppdf').textContent = s.pdf ? `(${s.pdf})` : '';
  document.getElementById('steptext').textContent = s.text;
  document.getElementById('stepcount').textContent = `${step + 1} / ${data.steps.length}`;
  document.getElementById('prev').disabled = step === 0;
  document.getElementById('next').disabled = step === data.steps.length - 1;
  const sp = document.getElementById('stepparts');
  sp.innerHTML = s.parts.map(k => {
    const e = entries.find(x => x.key === k);
    return `<span>${e ? e.label : k}</span>`;
  }).join('') || '<span style="border:0;background:none;color:var(--muted)">no new parts - hardware/wiring step</span>';
  const dbtn = document.getElementById('btn-done');
  dbtn.classList.toggle('done', done.has(step));
  dbtn.textContent = done.has(step) ? '✓ Built on the real bench' : 'Mark step built on the real bench';
  document.querySelectorAll('.chk').forEach((el, i) => {
    el.classList.toggle('current', i === step);
    el.querySelector('.m').textContent = done.has(i) ? '✓' : '';
  });
  pdfStepChanged();
}

// ---- embedded assembly instructions (pre-rendered pages) ----
const PDF_PAGES = 80;
let pdfPage = 1;
const pdfPanel = document.getElementById('pdfpanel');

function stepPdfRange() {
  const m = (data.steps[step].pdf || '').match(/(\d+)(?:-(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2] || m[1])];
}

function pdfShow(p) {
  pdfPage = Math.max(1, Math.min(PDF_PAGES, p));
  document.getElementById('pdfimg').src =
    `/viewer/assets/pdfpages/page_${String(pdfPage).padStart(2, '0')}.png`;
  const r = stepPdfRange();
  const inStep = r && pdfPage >= r[0] && pdfPage <= r[1];
  const lbl = document.getElementById('pdflabel');
  lbl.textContent = `p.${pdfPage}/${PDF_PAGES}` + (inStep ? ' — this step' : '');
  lbl.classList.toggle('instep', !!inStep);
  document.getElementById('pdfimg-wrap').scrollTop = 0;
}

function pdfStepChanged() {
  const r = stepPdfRange();
  document.getElementById('pdfstep').disabled = !r;
  if (r) pdfShow(r[0]);   // follow the build: each step opens on its own page
}

document.getElementById('pdfbtn').addEventListener('click', () => {
  pdfPanel.classList.toggle('show');
  if (pdfPanel.classList.contains('show')) pdfShow(pdfPage);
});
document.getElementById('pdfprev').addEventListener('click', () => pdfShow(pdfPage - 1));
document.getElementById('pdfnext').addEventListener('click', () => pdfShow(pdfPage + 1));
document.getElementById('pdfstep').addEventListener('click', () => {
  const r = stepPdfRange();
  if (r) pdfShow(r[0]);
});

function buildChecklist() {
  const list = document.getElementById('checklist');
  data.steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'chk';
    row.innerHTML = `<span class="n">${i}</span><span class="t">${s.title}</span><span class="m"></span>`;
    row.addEventListener('click', () => applyStep(i, false));
    list.appendChild(row);
  });
}

document.getElementById('prev').addEventListener('click', () => applyStep(step - 1, false));
document.getElementById('next').addEventListener('click', () => applyStep(step + 1, false));
document.getElementById('btn-done').addEventListener('click', () => {
  if (done.has(step)) done.delete(step); else done.add(step);
  localStorage.setItem(LSKEY, JSON.stringify([...done]));
  updateUI();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') applyStep(step + 1, false);
  if (e.key === 'ArrowLeft') applyStep(step - 1, false);
});

// ---- WASD fly camera -------------------------------------------------
// Moves the camera AND the orbit target together, so dragging still orbits
// around wherever you flew to. Velocity is smoothed both on press and
// release, and scales with orbit distance so it feels identical whether
// you're inspecting a screw or looking at the whole bench.
const keys = new Set();
const FLYKEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
let boost = false, creep = false;

function typing(el) {
  return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}
window.addEventListener('keydown', (e) => {
  boost = e.shiftKey; creep = e.altKey;
  const k = e.key.toLowerCase();
  if (FLYKEYS.has(k) && !e.ctrlKey && !e.metaKey && !typing(e.target)) {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  boost = e.shiftKey; creep = e.altKey;
  keys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => { keys.clear(); boost = creep = false; });

const flyVel = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);           // viewer is Z-up
const _want = new THREE.Vector3(), _step = new THREE.Vector3();

function flyUpdate(dt) {
  _want.set(0, 0, 0);
  if (keys.size) {
    camera.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, _up).normalize();
    if (keys.has('w')) _want.add(_fwd);
    if (keys.has('s')) _want.sub(_fwd);
    if (keys.has('d')) _want.add(_right);
    if (keys.has('a')) _want.sub(_right);
    if (keys.has('e')) _want.add(_up);
    if (keys.has('q')) _want.sub(_up);
    if (_want.lengthSq() > 0) {
      _want.normalize();
      // ~2 s to travel the current orbit radius: brisk but controllable
      let speed = camera.position.distanceTo(controls.target) * 0.45;
      speed = Math.min(Math.max(speed, 50), 1400);
      if (boost) speed *= 3;
      if (creep) speed *= 0.2;
      _want.multiplyScalar(speed);
    }
  }
  // critically-damped-ish approach: same curve accelerating and stopping
  flyVel.lerp(_want, 1 - Math.exp(-dt * 8));
  if (flyVel.lengthSq() < 1e-3) { flyVel.set(0, 0, 0); return; }
  _step.copy(flyVel).multiplyScalar(dt);
  camera.position.add(_step);
  controls.target.add(_step);       // keep orbiting about what's in front of you
}

// click to name + print
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let selected = null;
const pcard = document.getElementById('printcard');
const pstatus = document.getElementById('printstatus');

// ---- markup pins: Shift+click drops a numbered pin Claude can read ----
const pins = [];
const pinGroup = new THREE.Group();
scene.add(pinGroup);
const pinHud = document.createElement('div');
pinHud.style.cssText = 'position:fixed;left:12px;bottom:12px;background:#1d2027cc;border:1px solid #343a46;' +
  'border-radius:8px;padding:8px 10px;color:#d6dae2;font:12px system-ui;z-index:30;display:none';
pinHud.innerHTML = '<span id="pincount"></span> ' +
  '<button id="pinsend" style="margin-left:8px">send to Claude</button> ' +
  '<button id="pinclear" style="margin-left:4px">clear</button>' +
  '<div style="color:#8b93a3;margin-top:3px">Shift+click = pin · Shift+drag = draw</div>';
document.body.appendChild(pinHud);
function numberSprite(n) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffdd33'; g.beginPath(); g.arc(32, 32, 30, 0, 7); g.fill();
  g.fillStyle = '#000'; g.font = 'bold 36px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(9, 9, 1); s.raycast = () => {};
  return s;
}
function refreshPinHud() {
  pinHud.style.display = (pins.length || strokes.length) ? 'block' : 'none';
  const el = document.getElementById('pincount');
  if (el) el.textContent = pins.length + ' pin' + (pins.length === 1 ? '' : 's') +
    (strokes.length ? ' + ' + strokes.length + ' stroke' + (strokes.length === 1 ? '' : 's') : '');
}
function dropPin(hit, entry) {
  const n = pins.length + 1;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false }));
  dot.position.copy(hit.point); dot.raycast = () => {};
  const spr = numberSprite(n);
  spr.position.copy(hit.point).add(new THREE.Vector3(0, 0, 6));
  pinGroup.add(dot, spr);
  entry.mesh.updateMatrixWorld();
  const local = entry.mesh.worldToLocal(hit.point.clone());
  pins.push({
    n, part: entry.key, label: entry.label,
    world: hit.point.toArray().map(v => +v.toFixed(2)),
    desk_z: +(hit.point.z - 15.73).toFixed(2),
    local: local.toArray().map(v => +v.toFixed(2)),
  });
  refreshPinHud();
}
document.body.appendChild(pinHud);
pinHud.addEventListener('pointerdown', e => e.stopPropagation());
pinHud.querySelector('#pinclear').addEventListener('click', () => {
  pins.length = 0; strokes.length = 0; pinGroup.clear(); refreshPinHud();
});
pinHud.querySelector('#pinsend').addEventListener('click', async () => {
  await fetch('/markup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: 'build_j1', step, pins, strokes }) });
  pinHud.querySelector('#pinsend').textContent = 'sent ✓';
  setTimeout(() => { pinHud.querySelector('#pinsend').textContent = 'send to Claude'; }, 1500);
});

// strokes: Shift+drag paints a line on the surface; Shift+click = single pin
const strokes = [];
let curStroke = null;
function castAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  return ray.intersectObjects(entries.map(x => x.mesh), false)[0];
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.shiftKey) return;
  controls.enabled = false;
  curStroke = { pts: [], labels: new Set(), line: null };
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!curStroke || !e.shiftKey) return;
  const hit = castAt(e);
  if (!hit) return;
  const last = curStroke.pts[curStroke.pts.length - 1];
  if (last && hit.point.distanceTo(last) < 1.2) return;
  curStroke.pts.push(hit.point.clone());
  curStroke.labels.add(entries.find(x => x.mesh === hit.object)?.label || '?');
  if (curStroke.line) pinGroup.remove(curStroke.line);
  const g = new THREE.BufferGeometry().setFromPoints(curStroke.pts);
  curStroke.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff3333, depthTest: false }));
  curStroke.line.raycast = () => {};
  pinGroup.add(curStroke.line);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (curStroke) {
    controls.enabled = true;
    const st = curStroke; curStroke = null;
    if (st.pts.length >= 3) {
      strokes.push({
        n: strokes.length + 1, parts: [...st.labels],
        points: st.pts.map(p => p.toArray().map(v => +v.toFixed(2))),
      });
      refreshPinHud();
      return;
    }
    if (st.line) pinGroup.remove(st.line);
    const hit = castAt(e);          // short drag = treat as a click-pin
    if (hit) dropPin(hit, entries.find(x => x.mesh === hit.object));
    return;
  }
  const r = renderer.domElement.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(entries.map(x => x.mesh), false)[0];
  selected = hit ? entries.find(x => x.mesh === hit.object) : null;
  document.getElementById('partname').textContent = selected ? selected.label : '';
  pcard.classList.toggle('show', !!selected);
  if (selected) {
    const p = data.parts.find(x => x.key === selected.key);
    pcard.querySelector('.pn').textContent = selected.label;
    pcard.dataset.file = p.file;
    // AD5M bed is 220^3 (216 usable): grey it out for parts that only fit the P1S
    const bb = new THREE.Box3().setFromObject(selected.mesh);
    const ext = bb.getSize(new THREE.Vector3()).toArray().sort((a, b) => a - b);
    const ad5mBtn = pcard.querySelector('[data-printer="ad5m"]');
    const fits = ext.every(v => v <= 216);
    ad5mBtn.disabled = !fits;
    if (!fits && ad5mBtn.classList.contains('on')) selectPrinter('p1s');
  }
});

const ccard = document.getElementById('confirmcard');

function selectPrinter(key) {
  for (const b of pcard.querySelectorAll('.psel')) b.classList.toggle('on', b.dataset.printer === key);
}
for (const b of pcard.querySelectorAll('.psel')) {
  b.addEventListener('click', () => selectPrinter(b.dataset.printer));
}

for (const b of pcard.querySelectorAll('button[data-mat]')) {
  b.addEventListener('click', async () => {
    const file = pcard.dataset.file;
    if (!file) return;
    const printer = pcard.querySelector('.psel.on')?.dataset.printer || 'p1s';
    const r = await fetch('/print', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, material: b.dataset.mat, printer }) });
    if (r.status === 409) { pstatus.textContent = 'pipeline busy - one job at a time'; return; }
    pcard.classList.remove('show');
    pollStatus();
  });
}

document.getElementById('btn-confirm').addEventListener('click', async () => {
  ccard.classList.remove('show');
  await fetch('/print/confirm', { method: 'POST' });
  pollStatus();
});
document.getElementById('btn-cancel').addEventListener('click', async () => {
  ccard.classList.remove('show');
  await fetch('/print/cancel', { method: 'POST' });
});

let pollTimer = null;
async function pollStatus() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const s = await fetch('/print/status').then(r => r.json());
      pstatus.textContent = s.state === 'idle' ? '' : `print: ${s.state} — ${s.detail}`;
      pstatus.classList.toggle('active', ['slicing', 'uploading', 'starting', 'printing'].includes(s.state));
      if (s.state === 'await_confirm') {
        ccard.querySelector('.pn').textContent = s.part;
        ccard.querySelector('.eta').textContent = `estimated: ${s.eta || '?'} — check the plate is EMPTY, then:`;
        document.getElementById('previewimg').src = '/print/preview.png?ts=' + Date.now();
        ccard.classList.add('show');
        clearInterval(pollTimer); pollTimer = null;
        return;
      }
      if (['idle', 'done', 'error'].includes(s.state)) { clearInterval(pollTimer); pollTimer = null; }
    } catch (e) { /* server restarting */ }
  };
  pollTimer = setInterval(tick, 2000);
  tick();
}
pollStatus();

const DUR = 900;
let _lastT = 0;
function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min((t - _lastT) / 1000 || 0, 0.05);   // clamp tab-switch jumps
  _lastT = t;
  flyUpdate(dt);
  for (const e of entries) {
    if (e.t < 1 && e.from && e.to) {
      const k = Math.min(Math.max((t - e.t0) / DUR, 0), 1);
      e.t = k;
      if (k >= 1) {
        // land EXACTLY: arc residue here is what caused the ghost-hop bug
        e.mesh.position.copy(e.to.pos);
        e.mesh.quaternion.copy(e.to.quat);
        e.from = e.to = null;
      } else {
        const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        e.mesh.position.lerpVectors(e.from.pos, e.to.pos, ease);
        e.mesh.quaternion.slerpQuaternions(e.from.quat, e.to.quat, ease);
        // a little arc so parts "fly" rather than slide
        e.mesh.position.z += Math.sin(ease * Math.PI) * 60;
      }
    }
  }
  controls.update();
  renderer.render(scene, camera);
}
animate(0);
main();
