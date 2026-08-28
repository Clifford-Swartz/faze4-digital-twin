// FAZE4 arm assembly viewer.
// Scene units: millimetres, Z-up (URDF convention).
// URDF link meshes are authored in metres -> scaled x1000; print STLs are mm.

import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';
import { STLLoader } from './lib/STLLoader.js';

const DEG = Math.PI / 180;
const MESH_ROOT = '/Faze4/Faze4-Robotic-arm-master/URDF_FAZE4/meshes/';
const STL_ROOT = '/Faze4/STL/';

const GROUP_COLORS = {
  base: 0x7fa6d9,
  j2: 0xd9a06b,
  j3: 0x8fc98f,
  j4: 0xc98fc0,
  j5_forearm: 0xd9d06b,
  j6: 0x6bc9c9,
  rebuild_j1: 0xff7043,
  rebuild_gripper: 0xe0567a,   // the claw gets claw-machine raspberry
};
let rebuildOn = true;   // the rebuild IS the machine - stock-only is the toggle
const JOINT_LABELS = {
  rotary_base: 'base yaw',
  nadlaktica: 'shoulder',
  lakat: 'elbow',
  podlaktica: 'forearm roll',
  saka: 'wrist pitch',
  hvataljka: 'tool roll',
};

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// ---------------------------------------------------------------- scene setup
const viewport = document.getElementById('viewport');
const statusEl = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16181d);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
camera.up.set(0, 0, 1);
camera.position.set(950, -1150, 650);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(75, -225, 380);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// dolly is multiplicative: without a floor, fast scrolling collapses the
// distance to ~0, everything near-clips, and zoom-out can never recover
controls.minDistance = 40;
controls.maxDistance = 8000;

// OrbitControls zooms a fixed step per wheel EVENT (sign only, magnitude
// ignored). Trackpads emit dozens of tiny-delta events per gesture, so one
// flick hyper-zooms. Replace its zoom with a delta-proportional dolly.
controls.enableZoom = false;
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();                    // also stops ctrl+wheel page zoom
  let dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // lines -> px
  if (e.ctrlKey) dy *= 5;                // pinch reports tiny deltas
  const factor = Math.exp(dy * 0.0012);
  const offset = camera.position.clone().sub(controls.target);
  const d = Math.min(Math.max(offset.length() * factor, controls.minDistance),
                     controls.maxDistance);
  offset.setLength(d);
  camera.position.copy(controls.target).add(offset);
}, { passive: false });

// two lights + a soft hemisphere fill
const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(600, -900, 1200);
scene.add(dirLight);
const dirLight2 = new THREE.DirectionalLight(0x88aaff, 0.7);
dirLight2.position.set(-800, 500, 300);
scene.add(dirLight2);
scene.add(new THREE.HemisphereLight(0x99aabb, 0x333844, 0.55));

// grid floor (GridHelper lies in XZ; rotate into XY so z is up), at mesh floor z~15.7
const grid = new THREE.GridHelper(1600, 32, 0x3a4150, 0x262b34);
grid.rotation.x = Math.PI / 2;
grid.position.set(75, -225, 15.7);
scene.add(grid);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  // browser zoom / pinch changes devicePixelRatio - re-apply or the canvas
  // renders at the wrong scale afterwards
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------- helpers
function eulerZYX(rpyDeg) {
  // URDF fixed-axis XYZ rpy (R = Rz*Ry*Rx) == three.js intrinsic 'ZYX'
  return new THREE.Euler(rpyDeg[0] * DEG, rpyDeg[1] * DEG, rpyDeg[2] * DEG, 'ZYX');
}

const stlLoader = new STLLoader();
const geomCache = new Map(); // url -> Promise<BufferGeometry|null>
function loadSTL(url) {
  if (!geomCache.has(url)) {
    geomCache.set(url, new Promise((resolve) => {
      stlLoader.load(encodeURI(url),
        (geom) => resolve(geom),
        undefined,
        () => { console.warn('STL missing or failed to load: ' + url); resolve(null); });
    }));
  }
  return geomCache.get(url);
}

// ------------------------------------------------------------------- state
const linkGroups = {};   // link name -> THREE.Group (link frame)
const jointCtl = [];     // {name, node, axis, slider, valEl}
const partEntries = [];  // {mesh, pivot, basePos, expDir, expOrder, row, data, groupName}
const skinMeshes = [];   // link skin meshes
let selected = null;
let wireframe = false;
let loadedCount = 0, missingCount = 0, pendingCount = 0;

function updateStatus(msg) {
  statusEl.textContent = msg !== undefined ? msg :
    `${loadedCount} parts loaded` + (missingCount ? `, ${missingCount} missing` : '') +
    (pendingCount ? ` (${pendingCount} pending)` : '');
}

// --------------------------------------------------------------- data loading
async function main() {
  const [urdf, groups, rebuild] = await Promise.all([
    fetch('./data/urdf_assembly.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.json()),
    fetch('./data/viewer_transforms.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.json()),
    fetch('./data/rebuild_parts.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.json()).catch(() => []),
  ]);

  buildChain(urdf);
  buildJointUI(urdf);
  buildSkins(urdf);
  buildGroups(groups);
  buildGroups(rebuild);
  setupGripperJoint(rebuild);
  wireTwinDrive();   // needs jointCtl populated

  // stock<->rebuild toggle bookkeeping: rebuild parts start hidden; when the
  // toggle is on, they show and the stock parts they supersede hide.
  const replacedSet = new Set();
  for (const g of rebuild) for (const f of (g.replaces || [])) replacedSet.add(f);
  for (const e of partEntries) {
    e.isRebuild = e.groupName.startsWith('rebuild');
    e.isReplaced = !e.isRebuild && replacedSet.has(e.data.file);
    refreshPartVisibility(e);
  }

  wireButtons();

  // debug/scripting handle (used by automated tests; harmless in normal use)
  window.viewerDebug = { scene, camera, controls, linkGroups, jointCtl, partEntries, skinMeshes, select, applyHb, THREE };
}

// Build the kinematic chain: link frames connected by joint origin + rotation nodes.
function buildChain(urdf) {
  const root = new THREE.Group();
  root.name = 'base_link';
  scene.add(root);
  linkGroups['base_link'] = root;

  for (const j of urdf.joints) {
    const origin = new THREE.Group();          // fixed joint origin transform
    origin.position.fromArray(j.origin_xyz_mm);
    origin.setRotationFromEuler(eulerZYX(j.origin_rpy_deg));
    linkGroups[j.parent].add(origin);

    const rot = new THREE.Group();             // articulated node (q about axis)
    origin.add(rot);

    const child = new THREE.Group();
    child.name = j.child;
    rot.add(child);
    linkGroups[j.child] = child;

    jointCtl.push({
      name: j.name,
      node: rot,
      axis: new THREE.Vector3().fromArray(j.axis_child_frame).normalize(),
      limits: j.limits_deg, // null => continuous
    });
  }
}

function buildJointUI(urdf) {
  const sec = document.getElementById('joints-section');
  jointCtl.forEach((jc, i) => {
    const lo = jc.limits ? jc.limits[0] : -180;
    const hi = jc.limits ? jc.limits[1] : 180;
    const row = document.createElement('div');
    row.className = 'jrow';
    row.innerHTML =
      `<label title="${jc.name}">J${i + 1} ${JOINT_LABELS[jc.name] || jc.name}</label>` +
      `<input type="range" min="${lo}" max="${hi}" step="0.5" value="0">` +
      `<span class="val">0.0&deg;</span>`;
    sec.appendChild(row);
    jc.slider = row.querySelector('input');
    jc.valEl = row.querySelector('.val');
    jc.slider.addEventListener('input', () => {
      if (jc.chased) return;   // slider-drive chaser owns the visuals
      const q = parseFloat(jc.slider.value);
      jc.valEl.textContent = q.toFixed(1) + '°';
      jc.node.quaternion.setFromAxisAngle(jc.axis, q * DEG);
    });
  });
}

// ------------------------------------------------------------ gripper joint
// The compliant gripper's jaws counter-rotate about two pivots (data in the
// rebuild group's gripper_joint block). Jaw-flagged parts get re-nested under
// pivot groups and a J7 slider drives them.
let gripperSet = null;   // {drive, driven, axis, maxDeg, set(deg)}

function setupGripperJoint(rebuild) {
  const g = rebuild.find(x => x.gripper_joint);
  if (!g) return;
  const gj = g.gripper_joint;
  const groupNode = scene.getObjectByName('grp_' + g.group);
  if (!groupNode) return;
  const axis = new THREE.Vector3().fromArray(gj.axis).normalize();

  const mk = (pivotArr) => {
    const n = new THREE.Group();
    n.position.fromArray(pivotArr);
    groupNode.add(n);
    return n;
  };
  const drive = mk(gj.pivot_drive);
  const driven = mk(gj.pivot_driven);

  for (const pe of partEntries) {
    if (pe.groupName !== g.group || !pe.data.jaw) continue;
    (pe.data.jaw === 'drive' ? drive : driven).attach(pe.pivot);
    pe.basePos.copy(pe.pivot.position);   // keep explode math consistent
  }

  gripperSet = {
    drive, driven, axis, maxDeg: gj.max_deg || 35,
    set(deg) {
      // +x rotation moves +z-pointing arms toward +y: the -y (drive) jaw
      // needs +theta to swing AWAY from center, driven the mirror
      drive.quaternion.setFromAxisAngle(axis, deg * DEG);
      driven.quaternion.setFromAxisAngle(axis, -deg * DEG);
    },
  };

  // slider row alongside the other joints
  const sec = document.getElementById('joints-section');
  const row = document.createElement('div');
  row.className = 'jrow';
  row.innerHTML =
    `<label title="compliant gripper jaws">J7 gripper</label>` +
    `<input type="range" min="0" max="${gripperSet.maxDeg}" step="0.5" value="0">` +
    `<span class="val">0.0&deg;</span>`;
  sec.appendChild(row);
  const slider = row.querySelector('input');
  const val = row.querySelector('.val');
  slider.addEventListener('input', () => {
    const q = parseFloat(slider.value);
    val.textContent = q.toFixed(1) + '°';
    gripperSet.set(q);
  });
  gripperSet.slider = slider;
  gripperSet.valEl = val;
}

// Semi-transparent URDF link meshes ("skin").
function buildSkins(urdf) {
  const tree = document.getElementById('tree');
  const grpDiv = document.createElement('div');
  grpDiv.className = 'grp open';
  grpDiv.innerHTML =
    `<div class="grp-head"><span class="swatch" style="background:#9db4d9"></span>` +
    `<input type="checkbox" checked><span>URDF link skins</span>` +
    `<span class="cnt">${urdf.links.length}</span></div><div class="grp-parts"></div>`;
  tree.appendChild(grpDiv);
  const partsDiv = grpDiv.querySelector('.grp-parts');
  const head = grpDiv.querySelector('.grp-head');
  const headCb = head.querySelector('input');
  head.addEventListener('click', (e) => {
    if (e.target !== headCb) grpDiv.classList.toggle('open');
  });
  headCb.addEventListener('change', () => {
    for (const m of skinMeshes) m.userData.groupVisible = headCb.checked;
    refreshSkinVisibility();
  });

  for (const link of urdf.links) {
    const row = document.createElement('div');
    row.className = 'part-row';
    row.innerHTML =
      `<input type="checkbox" checked><span class="pname">${link.name}</span>` +
      `<span class="tag good">skin</span>`;
    partsDiv.appendChild(row);
    const cb = row.querySelector('input');

    pendingCount++; updateStatus();
    loadSTL(MESH_ROOT + link.mesh_file).then((geom) => {
      pendingCount--;
      if (!geom) {
        missingCount++;
        row.querySelector('.tag').textContent = 'missing';
        row.querySelector('.tag').className = 'tag missing';
        cb.disabled = true;
        updateStatus();
        return;
      }
      const c = link.color_rgba || [0.79, 0.82, 0.93, 1];
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(c[0], c[1], c[2]),
        transparent: true, opacity: 0.16, depthWrite: false,
        roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.scale.setScalar(1000);            // metres -> mm
      mesh.renderOrder = 2;                  // draw after solids
      mesh.userData = { isSkin: true, selfVisible: true, groupVisible: true, label: link.name };
      linkGroups[link.name].add(mesh);
      skinMeshes.push(mesh);
      refreshSkinVisibility();           // honor the default state at load
      loadedCount++;
      updateStatus();
      cb.addEventListener('change', () => {
        mesh.userData.selfVisible = cb.checked;
        refreshSkinVisibility();
      });
    });
  }
}

let skinsOn = false;  // URDF reference ghosts - alignment scaffolding, off by default
function refreshSkinVisibility() {
  for (const m of skinMeshes) {
    m.visible = skinsOn && m.userData.selfVisible && m.userData.groupVisible;
  }
}

// Parts the transforms data flags (open_issues) as physically riding a different
// link than their group's attach_link. Re-parented world-preserving at zero pose
// so they articulate with the correct joint.
const REPARENT = {
  base: {
    'Rotating base/Joint 1 output shaft.STL': 'rotary_base',
    'Base/Shaft blocker.STL': 'rotary_base',
    'Rotating base/Rotating base wires.STL': 'rotary_base',
    'Rotating base/Rotating base motor.STL': 'rotary_base',
  },
  j2: { 'Arm+J2/J2 cyclo/Joint 2 output shaft.STL': 'rotary_base' },
  rebuild_j1: { '/cad/j1/stl/j1_shaft_blocker.stl': 'rotary_base' },
  j4: { 'Elbow/Joint 4 pulley 28 teeth.STL': 'podlaktica' },
  // wrist-side pulley (2nd instance) + J5 trigger bolt to the wrist case: ride saka
  j5_forearm: {
    'Forearm/Joint 5 28 teeth pulley.STL#2': 'saka',
    'Forearm/Joint 5 switch trigger.STL': 'saka',
  },
  // J6 output shaft is the tool flange: it rotates with the tool-roll joint
  j6: { 'Wrist/Joint 6 output shaft.STL': 'hvataljka' },
};

// Print-part groups.
function buildGroups(groups) {
  const tree = document.getElementById('tree');
  for (const g of groups) {
    const color = GROUP_COLORS[g.group] || 0xaaaaaa;
    const attach = linkGroups[g.attach_link];
    if (!attach) { console.warn('Unknown attach_link ' + g.attach_link); continue; }

    const groupNode = new THREE.Group();
    groupNode.name = 'grp_' + g.group;
    groupNode.position.fromArray(g.group_offset || [0, 0, 0]);
    attach.add(groupNode);

    const grpDiv = document.createElement('div');
    grpDiv.className = 'grp';
    grpDiv.innerHTML =
      `<div class="grp-head"><span class="swatch" style="background:#${color.toString(16).padStart(6, '0')}"></span>` +
      `<input type="checkbox" checked><span>${g.group} &rarr; ${g.attach_link}</span>` +
      `<span class="cnt">${g.parts.length}</span></div><div class="grp-parts"></div>`;
    tree.appendChild(grpDiv);
    const partsDiv = grpDiv.querySelector('.grp-parts');
    const head = grpDiv.querySelector('.grp-head');
    const headCb = head.querySelector('input');
    head.addEventListener('click', (e) => {
      if (e.target !== headCb) grpDiv.classList.toggle('open');
    });

    const groupParts = [];
    headCb.addEventListener('change', () => {
      for (const pe of groupParts) {
        pe.groupVisible = headCb.checked;
        refreshPartVisibility(pe);
      }
    });

    // instance numbering for duplicate files within a group
    const nameCounts = {};
    for (const p of g.parts) nameCounts[p.file] = (nameCounts[p.file] || 0) + 1;
    const nameSeen = {};

    for (const p of g.parts) {
      const base = p.file.split('/').pop().replace(/\.stl$/i, '');
      nameSeen[p.file] = (nameSeen[p.file] || 0) + 1;
      const label = nameCounts[p.file] > 1 ? `${base} #${nameSeen[p.file]}` : base;

      const row = document.createElement('div');
      row.className = 'part-row';
      const confClass = p.confidence === 'exact' ? 'exact' : (p.confidence === 'good' ? 'good' : 'approx');
      row.innerHTML =
        `<input type="checkbox" checked><span class="pname" title="${p.file}">${label}</span>` +
        `<span class="tag ${confClass}">${p.confidence || ''}</span>`;
      partsDiv.appendChild(row);
      const cb = row.querySelector('input');

      if (!p.translate) continue;   // unplaced part (e.g. staged-only STL)
      const pivot = new THREE.Group();
      pivot.position.fromArray(p.translate);
      pivot.setRotationFromEuler(eulerZYX(p.rotate_deg));
      groupNode.add(pivot);

      const entry = {
        pivot,
        mesh: null,
        basePos: new THREE.Vector3().fromArray(p.translate),
        expDir: new THREE.Vector3().fromArray(p.explode_dir || [0, 0, 1]).normalize(),
        expOrder: p.explode_order || 0,
        row, cb,
        data: p,
        label: `${g.group} / ${label}`,
        groupName: g.group,
        selfVisible: true,
        groupVisible: true,
      };
      if (p.default_hidden) {              // e.g. upstream-bugged STLs
        entry.selfVisible = false;
        cb.checked = false;
      }
      const rpTarget = REPARENT[g.group] &&
        (REPARENT[g.group][p.file + '#' + nameSeen[p.file]] || REPARENT[g.group][p.file]);
      if (rpTarget && linkGroups[rpTarget]) {
        const target = linkGroups[rpTarget];
        const qOld = new THREE.Quaternion(), qNew = new THREE.Quaternion();
        groupNode.getWorldQuaternion(qOld);
        target.getWorldQuaternion(qNew);
        target.attach(pivot);              // joints are all at zero: world pose preserved
        entry.basePos.copy(pivot.position);
        entry.expDir.applyQuaternion(qOld).applyQuaternion(qNew.invert());
        entry.label += ' (rides ' + rpTarget + ')';
      }

      groupParts.push(entry);
      partEntries.push(entry);

      pendingCount++; updateStatus();
      loadSTL(p.file.startsWith('/') ? p.file : STL_ROOT + p.file).then((geom) => {
        pendingCount--;
        if (!geom) {
          missingCount++;
          const tag = row.querySelector('.tag');
          tag.textContent = 'missing';
          tag.className = 'tag missing';
          cb.disabled = true;
          updateStatus();
          return;
        }
        const mat = new THREE.MeshStandardMaterial({
          color, roughness: 0.55, metalness: 0.15,
          wireframe,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.entry = entry;
        entry.mesh = mesh;
        pivot.add(mesh);
        loadedCount++;
        updateStatus();
      });

      cb.addEventListener('change', () => {
        entry.selfVisible = cb.checked;
        refreshPartVisibility(entry);
      });
      row.addEventListener('click', (e) => {
        if (e.target === cb) return;
        select(entry);
      });
    }
  }
}

function refreshPartVisibility(pe) {
  const modeOk = pe.isRebuild ? rebuildOn : !(rebuildOn && pe.isReplaced);
  pe.pivot.visible = pe.selfVisible && pe.groupVisible && modeOk;
}

// ---------------------------------------------------------------- explode
const explodeSlider = document.getElementById('explode');
const explodeVal = document.getElementById('explode-val');
function applyExplode() {
  const t = parseFloat(explodeSlider.value);
  explodeVal.textContent = t.toFixed(2);
  // a forgotten partial explode reads as "parts doubled up" - make it loud
  explodeVal.style.color = t > 0 ? 'var(--warn)' : '';
  explodeVal.style.fontWeight = t > 0 ? 'bold' : '';
  for (const pe of partEntries) {
    const d = t * (30 + 22 * pe.expOrder);
    pe.pivot.position.copy(pe.basePos).addScaledVector(pe.expDir, d);
  }
}
explodeSlider.addEventListener('input', applyExplode);

// ---------------------------------------------------------------- selection
const infoEl = document.getElementById('info');
function select(entry) {
  if (selected && selected.mesh) selected.mesh.material.emissive.setHex(0x000000);
  if (selected) selected.row.classList.remove('selected');
  selected = entry;
  if (!entry) {
    infoEl.innerHTML = `<span class="iname">Nothing selected</span>` +
      `<div class="inotes">Click a part in the 3D view or in the tree above.</div>`;
    return;
  }
  entry.row.classList.add('selected');
  entry.row.scrollIntoView({ block: 'nearest' });
  if (entry.mesh) entry.mesh.material.emissive.setHex(0xcc5500);
  const p = entry.data;
  infoEl.innerHTML =
    `<span class="iname">${entry.label}</span>` +
    `<div class="inotes">file: ${p.file}<br>confidence: ${p.confidence || 'n/a'}` +
    `; explode order ${p.explode_order}</div>` +
    `<div class="inotes">${p.notes || ''}</div>`;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 5) return; // was a drag
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = partEntries.filter(pe => pe.mesh && pe.pivot.visible).map(pe => pe.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  select(hits.length ? hits[0].object.userData.entry : null);
});

// ---------------------------------------------------------------- buttons
function wireButtons() {
  document.getElementById('btn-reset').addEventListener('click', () => {
    for (const jc of jointCtl) {
      jc.slider.value = 0;
      jc.valEl.textContent = '0.0°';
      jc.node.quaternion.identity();
    }
    if (gripperSet) {
      gripperSet.slider.value = 0;
      gripperSet.valEl.textContent = '0.0°';
      gripperSet.set(0);
    }
    explodeSlider.value = 0;
    applyExplode();
  });

  document.getElementById('btn-explode').addEventListener('click', () => {
    explodeSlider.value = parseFloat(explodeSlider.value) > 0.5 ? 0 : 1;
    applyExplode();
  });

  const wireBtn = document.getElementById('btn-wire');
  wireBtn.addEventListener('click', () => {
    wireframe = !wireframe;
    wireBtn.classList.toggle('active', wireframe);
    for (const pe of partEntries) if (pe.mesh) pe.mesh.material.wireframe = wireframe;
  });

  const skinBtn = document.getElementById('btn-skin');
  skinBtn.addEventListener('click', () => {
    skinsOn = !skinsOn;
    skinBtn.classList.toggle('active', skinsOn);
    refreshSkinVisibility();
  });

  const rebuildBtn = document.getElementById('btn-rebuild');
  if (rebuildBtn) rebuildBtn.addEventListener('click', () => {
    rebuildOn = !rebuildOn;
    rebuildBtn.classList.toggle('active', rebuildOn);
    for (const pe of partEntries) refreshPartVisibility(pe);
  });
}

// ---------------------------------------------------------------- live twin
// Telemetry feed via SSE. Heartbeats come from SAME70 debug UART -> serve.py.
// Each heartbeat carries velocity/position; we apply it through the gear
// reduction so the joint moves at true output speed.
// Use serve.py --serial <PORT> to enable the relay.
const LIVE_URL = '/events';  // same origin as the viewer
const LIVE_MAP = {                       // CAN node -> joint
  0: { j: 0, ratio: 25, name: 'J1 base yaw' },    // IMU yaw -> J1
  1: { j: 1, ratio: 50, name: 'J2 shoulder' },    // IMU pitch -> J2
  2: { j: 2, ratio: 50, name: 'J3 elbow' },       // IMU pitch -> J3
  3: { j: 4, ratio: 25, name: 'J5 wrist pitch' }, // IMU roll -> J5 (j:4 since J4 is skipped)
};
const AXIS_STATES = {
  0: 'UNDEF', 1: 'IDLE', 2: 'STARTUP', 3: 'FULL_CALIB', 4: 'MOTOR_CALIB',
  6: 'IDX_SEARCH', 7: 'OFFSET_CALIB', 8: 'CLOSED_LOOP', 9: 'LOCKIN',
};
let liveSrc = null;
let liveLastT = null;
const liveNodes = {};                    // node -> {vel, state, err, at}

// single entry point for heartbeats, whether they arrive over the SSE feed
// (tkinter console driving) or the page's own Web Bluetooth link
const LIVE_SIGN = +1;      // flips if the twin turns opposite the metal
function applyHb(node, state, err, vel, pos) {
  const prev = liveNodes[node];
  liveNodes[node] = { vel, state, err, pos, at: performance.now() };
  // absolute position tracking: encoder pos (motor turns) -> joint angle.
  // zero-reference = the twin's angle when the first pos sample arrived.
  const m = LIVE_MAP[node];
  if (pos !== null && pos !== undefined && m) {
    const jc = jointCtl[m.j];
    if (jc) {
      if (!m.posRef || prev === undefined || prev === null || prev.pos === undefined || prev.pos === null) {
        m.posRef = { pos, angle: parseFloat(jc.slider.value) };
      }
      let q = m.posRef.angle + LIVE_SIGN * ((pos - m.posRef.pos) / m.ratio) * 360;
      if (jc.limits) q = Math.max(jc.limits[0], Math.min(jc.limits[1], q));
      else q = ((q + 180) % 360 + 360) % 360 - 180;
      jc.slider.value = q;
      jc.valEl.textContent = q.toFixed(1) + '°';
      jc.node.quaternion.setFromAxisAngle(jc.axis, q * DEG);
    }
  }
  const r = motorRows[node];
  if (r) {
    r.state.textContent = `${AXIS_STATES[state] || 'state ' + state} · ${vel.toFixed(1)} t/s` +
      (err ? ` · ERR ${err.toString(16)}` : '');
    r.state.style.color = err ? 'var(--bad)' : (state === 8 ? 'var(--good)' : 'var(--muted)');
  }
  document.getElementById('live-status').textContent = liveStatusText();
}

function liveIntegrate(t) {
  if (liveLastT === null) { liveLastT = t; return; }
  const dt = Math.min((t - liveLastT) / 1000, 0.1);
  liveLastT = t;
  for (const node in LIVE_MAP) {
    const s = liveNodes[node];
    const m = LIVE_MAP[node];
    // heartbeats come every 500 ms; a silent node is a stopped node
    if (!s || !s.vel || performance.now() - s.at > 2000) continue;
    if (s.pos !== null && s.pos !== undefined) continue;   // absolute tracking owns this node
    const jc = jointCtl[m.j];
    if (!jc) continue;
    let q = parseFloat(jc.slider.value) + (s.vel / m.ratio) * 360 * dt;
    if (jc.limits) q = Math.max(jc.limits[0], Math.min(jc.limits[1], q));
    else q = ((q + 180) % 360 + 360) % 360 - 180;
    jc.slider.value = q;
    jc.valEl.textContent = q.toFixed(1) + '°';
    jc.node.quaternion.setFromAxisAngle(jc.axis, q * DEG);
  }
}

function liveStatusText() {
  const bits = [];
  for (const node in liveNodes) {
    const s = liveNodes[node];
    const m = LIVE_MAP[node];
    bits.push(`n${node}→${m ? 'J' + (m.j + 1) : '?'} ` +
      `${AXIS_STATES[s.state] || 'state ' + s.state} ${s.vel.toFixed(1)} t/s` +
      (s.err ? ` ERR ${s.err.toString(16)}` : ''));
  }
  return bits.length ? 'live: ' + bits.join(' · ') : 'live: waiting for heartbeats…';
}

function wireLive() {
  const btn = document.getElementById('btn-live');
  const status = document.getElementById('live-status');
  btn.addEventListener('click', () => {
    if (liveSrc) {
      liveSrc.close();
      liveSrc = null;
      liveLastT = null;
      btn.classList.remove('active');
      status.textContent = '';
      return;
    }
    liveSrc = new EventSource(LIVE_URL);
    btn.classList.add('active');
    status.textContent = 'live: connecting…';
    liveSrc.onopen = () => { status.textContent = 'live: waiting for heartbeats…'; };
    liveSrc.onmessage = (e) => {
      // SSE data is raw HB line from serve.py serial relay
      onBleLine(e.data);
      status.textContent = liveStatusText();
    };
    liveSrc.onerror = () => {              // EventSource retries on its own
      status.textContent = 'live: no feed — is serve.py --serial running?';
    };
  });
}
wireLive();

// ------------------------------------------------------- motor console (BLE)
// The page owns the BLE link directly via Web Bluetooth (Edge/Chrome; localhost
// counts as a secure context). Same line protocol as tools/motor_gui.py:
// V,<node>,<mvel> / GO / STOP / CLR; HB,<node>,<state>,<err_hex>,<mrad_s> back.
// Only one central can hold the link - this and the tkinter console are
// mutually exclusive by construction. On BLE drop the firmware stops all
// motors itself (%DISCONNECT% handler).
const BLE_NAME = 'CLAW_RX__1292';
const BLE_SVC = '49535343-fe7d-4ae5-8fa9-9fafd205e455';  // Microchip transparent UART
const BLE_TX = '49535343-1e4d-4bd9-ba61-23c647249616';   // notify: module -> host
const BLE_RX = '49535343-8841-43f4-a8d4-ecbe34729bb3';   // write:  host -> module
const MIN_SPIN = 3.0;                                    // sensorless floor, turns/s

const motorRows = {};
const bleStatusEl = document.getElementById('ble-status');
const ble = { dev: null, rxChar: null, connected: false, chain: Promise.resolve(), buf: '' };

function canCommand() {
  // direct BLE, or relayed through the tkinter GUI's twin server
  return ble.connected || !!liveSrc;
}

function bleSend(line) {
  if (ble.connected) {
    const bytes = new TextEncoder().encode(line + '\n');
    // GATT allows one operation at a time - serialize writes on a promise chain
    ble.chain = ble.chain
      .then(() => ble.rxChar.writeValueWithResponse(bytes))
      .catch(() => {});
  } else if (liveSrc) {
    fetch('http://localhost:8348/cmd', { method: 'POST', body: line,
      headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  }
}

function bleStopAll() {
  for (const node in LIVE_MAP) bleSend(`STOP,${node}`);
}

function onBleLine(text) {
  if (!text.startsWith('HB,')) return;
  const p = text.split(',');
  if (p.length < 5) return;
  // sensorless velocity estimate arrives in milli-rad/s
  applyHb(parseInt(p[1]), parseInt(p[2]), parseInt(p[3], 16),
          parseInt(p[4]) / 1000 / (2 * Math.PI),
          p.length > 5 ? parseInt(p[5]) / 1000 : null);
}

async function bleConnect() {
  if (!navigator.bluetooth) {
    bleStatusEl.textContent = 'bluetooth: Web Bluetooth unavailable — use Edge or Chrome';
    return;
  }
  try {
    bleStatusEl.textContent = 'bluetooth: pick the device…';
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ name: BLE_NAME }], optionalServices: [BLE_SVC],
    });
    dev.addEventListener('gattserverdisconnected', bleDown);
    // GATT setup is flaky on Windows (random cancels) - retry, and never
    // leave the module half-grabbed on failure
    let txChar = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        bleStatusEl.textContent = `bluetooth: connecting… (try ${attempt})`;
        const gatt = await dev.gatt.connect();
        const svc = await gatt.getPrimaryService(BLE_SVC);
        ble.rxChar = await svc.getCharacteristic(BLE_RX);
        txChar = await svc.getCharacteristic(BLE_TX);
        await txChar.startNotifications();
        break;
      } catch (e) {
        txChar = null;
        try { dev.gatt.disconnect(); } catch (_) {}
        if (attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    txChar.addEventListener('characteristicvaluechanged', (e) => {
      ble.buf += new TextDecoder().decode(e.target.value);
      let i;
      while ((i = ble.buf.indexOf('\n')) >= 0) {
        const line = ble.buf.slice(0, i).trim();
        ble.buf = ble.buf.slice(i + 1);
        if (line) onBleLine(line);
      }
    });
    ble.dev = dev;
    ble.connected = true;
    document.getElementById('ble-connect').textContent = 'Disconnect';
    document.getElementById('ble-stopall').disabled = false;
    bleStatusEl.textContent = `bluetooth: connected (${BLE_NAME})`;
  } catch (err) {
    bleStatusEl.textContent = 'bluetooth: ' + err.message;
  }
}

function bleDown() {
  ble.connected = false;
  ble.rxChar = null;
  ble.dev = null;
  ble.buf = '';
  ble.chain = Promise.resolve();
  document.getElementById('ble-connect').textContent = 'Connect motors';
  document.getElementById('ble-stopall').disabled = true;
  bleStatusEl.textContent = 'bluetooth: disconnected (firmware stops all motors on drop)';
}

function buildMotorRows() {
  const host = document.getElementById('motor-rows');
  for (const node in LIVE_MAP) {
    const m = LIVE_MAP[node];
    const div = document.createElement('div');
    div.className = 'mrow';
    div.innerHTML =
      `<div class="mhead"><span>${m.name} (n${node}&rarr;J${m.j + 1})</span>` +
      `<span class="mstate">—</span></div>` +
      `<div class="jrow"><input type="range" min="-15" max="15" step="0.5" value="0">` +
      `<span class="val">+0.0</span></div>` +
      `<div class="btnrow"><button class="go">GO</button>` +
      `<button class="stop">STOP</button><button class="clr">CLR ERR</button></div>` +
      `<div class="btnrow"><button class="nudge" data-t="-5000">&#9668;&#9668; 5</button>` +
      `<button class="nudge" data-t="-1000">&#9668; 1</button>` +
      `<button class="nudge" data-t="1000">1 &#9658;</button>` +
      `<button class="nudge" data-t="5000">5 &#9658;&#9658;</button></div>`;
    host.appendChild(div);
    const slider = div.querySelector('input');
    const val = div.querySelector('.val');
    const row = { slider, val, state: div.querySelector('.mstate'), lastSent: null };
    const snapped = () => {
      let v = Math.round(parseFloat(slider.value) * 2) / 2;
      if (v !== 0 && Math.abs(v) < MIN_SPIN) v = v > 0 ? MIN_SPIN : -MIN_SPIN;
      return v;
    };
    slider.addEventListener('input', () => {
      const v = snapped();
      val.textContent = (v >= 0 ? '+' : '') + v.toFixed(1);
      if (v !== row.lastSent) {
        row.lastSent = v;
        bleSend(`V,${node},${Math.round(v * 1000)}`);
      }
    });
    div.querySelector('.go').addEventListener('click', () => {
      let v = snapped();
      if (v === 0) {
        v = MIN_SPIN;
        slider.value = v;
        val.textContent = '+' + v.toFixed(1);
      }
      // teleop fw rebuilt 2026-08-12: GO is clean CANSimple (clear+mode+arm)
      bleSend(`V,${node},${Math.round(v * 1000)}
GO,${node}`);
    });
    div.querySelector('.stop').addEventListener('click', () => bleSend(`STOP,${node}`));
    div.querySelector('.clr').addEventListener('click', () => bleSend(`CLR,${node}`));
    for (const b of div.querySelectorAll('.nudge')) {
      b.addEventListener('click', () => bleSend(`N,${node},${b.dataset.t}`));
    }
    motorRows[node] = row;
  }
}

// arrow keys: nudge J1 (node 0). Tap ~5 deg of platform, Shift ~20 deg.
// 25:1 -> 5 deg output = 0.347 motor turns = 347 mturns. Sign flips if the
// bench says so - one constant.
const NUDGE_SIGN = +1;
// visible hint under the live status
(() => {
  const ls = document.getElementById('live-status');
  if (ls && !document.getElementById('nudge-hint')) {
    const h = document.createElement('div');
    h.id = 'nudge-hint';
    h.style.cssText = 'color:#8b93a3;font-size:11.5px;margin-top:3px';
    h.textContent = '←/→ nudge J1 ~5° · Shift = ~20° (BLE connected)';
    ls.parentNode.insertBefore(h, ls.nextSibling);
  }
})();
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target && e.target.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
  e.preventDefault();
  const mag = e.shiftKey ? 1400 : 350;                  // motor milli-turns
  const dir = (e.key === 'ArrowRight' ? 1 : -1) * NUDGE_SIGN;
  // 1) twin moves NOW (intent display) - unless live encoder feedback is
  // fresh, in which case the real arm's telemetry owns the twin
  const jc = jointCtl[LIVE_MAP[0].j];
  const hbFresh = liveNodes[0] && (performance.now() - liveNodes[0].at) < 2000;
  if (jc && !hbFresh) {
    let q = parseFloat(jc.slider.value) + (dir * mag / 1000 / LIVE_MAP[0].ratio) * 360;
    if (jc.limits) q = Math.max(jc.limits[0], Math.min(jc.limits[1], q));
    else q = ((q + 180) % 360 + 360) % 360 - 180;
    jc.slider.value = q;
    jc.valEl.textContent = q.toFixed(1) + '°';
    jc.node.quaternion.setFromAxisAngle(jc.axis, q * DEG);
  }
  // 2) the real arm chases over BLE -> SAME70 -> CAN
  if (canCommand()) bleSend(`N,0,${dir * mag}`);
});

// -------------------------------------------------- twin drive (slider -> motor)
// When enabled and BLE-connected, releasing a joint slider sends the angle
// delta through the gear ratio as a nudge: the real motor chases the twin.
// Dead reckoning until encoders arrive - the twin is the authority.
let twinDrive = false;
let twinChase = null;           // visual chaser: twin joints glide at motor speed
const MIN_NUDGE_MTURNS = 250;   // quarter turn: firmware now stops bursts on
                                // MEASURED travel, so smaller chunks stay honest
const MAX_NUDGE_MTURNS = 1200;  // chunk cap: ~0.4s bursts keep it responsive
const TWIN_TICK_MS = 150;

function wireTwinDrive() {
  const btn = document.getElementById('btn-twindrive');
  const nodeByJoint = {};
  for (const node in LIVE_MAP) nodeByJoint[LIVE_MAP[node].j] = { node, ratio: LIVE_MAP[node].ratio };
  const lastSent = {};   // joint deg actually dispatched to the motor
  const target = {};     // joint deg the slider wants
  const nextAt = {};     // per-joint: when the current burst finishes
  let timer = null;

  const tick = () => {
    if (!canCommand()) return;
    const now = performance.now();
    for (const i in target) {
      if (now < (nextAt[i] || 0)) continue;      // let the last burst finish
      const { node, ratio } = nodeByJoint[i];
      let mturns = Math.round((target[i] - lastSent[i]) / 360 * ratio * 1000);
      if (Math.abs(mturns) < MIN_NUDGE_MTURNS) {
        if (Math.abs(mturns) > 60) {
          bleStatusEl.textContent = `J${+i + 1}: banking ${(mturns / 1000).toFixed(2)} ` +
            `turns (moves at ±${(MIN_NUDGE_MTURNS / 1000).toFixed(1)})`;
        }
        continue;
      }
      mturns = Math.max(-MAX_NUDGE_MTURNS, Math.min(MAX_NUDGE_MTURNS, mturns));
      bleSend(`N,${node},${mturns}`);
      lastSent[i] += mturns / 1000 / ratio * 360;  // credit what was SENT
      nextAt[i] = now + Math.abs(mturns) / 3.0 + 60;  // ms: |turns|/3t/s + margin
      bleStatusEl.textContent = `J${+i + 1} -> node ${node}: ` +
        `${mturns > 0 ? '+' : ''}${(mturns / 1000).toFixed(2)} turns (chasing ${target[i].toFixed(0)}°)`;
    }
  };

  jointCtl.forEach((jc, i) => {
    if (!nodeByJoint[i]) return;
    lastSent[i] = 0;
    target[i] = 0;
    const follow = () => {
      const val = parseFloat(jc.slider.value);
      if (!twinDrive) { lastSent[i] = val; target[i] = val; return; }
      target[i] = val;
      if (!canCommand()) {
        lastSent[i] = val;
        bleStatusEl.textContent = 'slider drive is ON but no link — Connect motors here, or turn on ● Live with the GUI running';
      }
    };
    jc.slider.addEventListener('input', follow);   // live, while dragging
    jc.slider.addEventListener('change', follow);  // and on release
  });

  // visual chaser: the on-screen joint moves at the true dead-reckoned motor
  // rate (NUDGE_VEL through the gear ratio), so twin and hardware arrive together
  const shown = {};
  twinChase = (dtSec) => {
    for (const i in target) {
      const jc = jointCtl[i];
      const rate = 3.0 / nodeByJoint[i].ratio * 360;   // deg/s at the joint
      const d = target[i] - shown[i];
      if (d === 0) continue;
      const step = Math.min(Math.abs(d), rate * dtSec) * Math.sign(d);
      shown[i] += step;
      jc.valEl.textContent = shown[i].toFixed(1) + '°';
      jc.node.quaternion.setFromAxisAngle(jc.axis, shown[i] * DEG);
    }
  };

  btn.addEventListener('click', () => {
    twinDrive = !twinDrive;
    btn.classList.toggle('active', twinDrive);
    // adopt current positions so enabling never fires a surprise move
    jointCtl.forEach((jc, i) => {
      if (i in lastSent) {
        lastSent[i] = parseFloat(jc.slider.value);
        target[i] = lastSent[i];
        shown[i] = lastSent[i];
        jc.chased = twinDrive;
        // arrow-key step = one honest burst quantum while driving hardware
        // (sub-burst steps are pure sensorless spin-up ceremony)
        jc.slider.step = twinDrive
          ? (MIN_NUDGE_MTURNS / 1000 / nodeByJoint[i].ratio * 360).toFixed(1)
          : 0.5;
        if (!twinDrive) {   // hand visuals back to the slider
          jc.valEl.textContent = target[i].toFixed(1) + '°';
          jc.node.quaternion.setFromAxisAngle(jc.axis, target[i] * DEG);
        }
      }
    });
    if (twinDrive && !timer) timer = setInterval(tick, TWIN_TICK_MS);
    if (!twinDrive && timer) { clearInterval(timer); timer = null; }
  });

  // Reset pose walks the real motors home too (the ticker does the moving)
  document.getElementById('btn-reset').addEventListener('click', () => {
    for (const i in target) {
      target[i] = 0;
      if (!twinDrive || !canCommand()) lastSent[i] = 0;
    }
  });
}

function wireMotors() {
  buildMotorRows();
  document.getElementById('ble-connect').addEventListener('click', () => {
    if (ble.connected) {
      const dev = ble.dev;
      bleStopAll();
      ble.chain.then(() => dev.gatt.disconnect());
    } else {
      bleConnect();
    }
  });
  document.getElementById('ble-stopall').addEventListener('click', bleStopAll);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && ble.connected) {
      e.preventDefault();
      bleStopAll();
    }
  });
}
wireMotors();

// ---------------------------------------------------------------- render loop
let lastFrameT = 0;
function animate(t) {
  requestAnimationFrame(animate);
  const dt = Math.min((t - lastFrameT) / 1000 || 0, 0.1);
  lastFrameT = t || 0;
  // in slider-drive mode the sliders are the pose authority - telemetry
  // integration would double-move them; the chaser animates at motor speed
  if (canCommand() && !twinDrive) liveIntegrate(t || 0);
  if (twinDrive && twinChase) twinChase(dt);
  controls.update();
  renderer.render(scene, camera);
}
animate();

main().catch((err) => {
  console.error(err);
  updateStatus('Failed to load data: ' + err.message);
});
