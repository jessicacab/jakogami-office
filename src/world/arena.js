import * as THREE from 'three';
import { ARENA } from '../config/duel.js';

/* ================= The duel arena: the office rooftop at dusk ================= */
// A scene of its own (docs/DUEL-SPEC.md, Phase 1.1): the building's roof with a helipad as the ring, rooftop plant, a
// few lamps, and a city skyline with lit windows falling away below, under a sunset sky. Nothing here touches the
// office scene. Built the first time someone enters the arena (ui/duelArena.js), disposed with the office.
// The helipad's middle is the origin; fighters stay within ARENA.radius of it (the server keeps them there).
const arena = { scene: null, camera: null, beacons: [], t: 0 };
const ROOF = 17;        // half the roof's width, metres
const DROP = 46;        // how far below the roof the street is
const rnd = (a, b) => a + Math.random() * (b - a);

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: .9, metalness: 0, ...o });
function mesh(parent, geometry, material, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m);
  return m;
}

// The sky: deep indigo overhead, through violet, to a hot orange horizon (a canvas gradient on the inside of a sphere).
function sky(scene) {
  const tex = canvasTexture(4, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#141530'); grad.addColorStop(.32, '#3a2a5e'); grad.addColorStop(.44, '#8a4a78');
    grad.addColorStop(.5, '#ff8a4c'); grad.addColorStop(.53, '#ffb067'); grad.addColorStop(.6, '#4a2f45'); grad.addColorStop(1, '#1b1426');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(dome);
  // the low sun, a soft disc on the horizon behind the skyline
  const glow = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,240,200,1)'); r.addColorStop(.25, 'rgba(255,180,100,.9)'); r.addColorStop(1, 'rgba(255,120,60,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  });
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, fog: false, depthWrite: false, transparent: true }));
  sun.position.set(-250, 18, -150); sun.scale.setScalar(70); scene.add(sun);
}

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffb98a, 0x231c33, 1.1));
  const sun = new THREE.DirectionalLight(0xff9b5c, 2.6);
  sun.position.set(-25, 9, -15); sun.target.position.set(0, 0, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 70 });
  sun.shadow.bias = -.0005; sun.shadow.normalBias = .03;
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight(0x8fa0ff, .55); rim.position.set(20, 14, 18); scene.add(rim);
}

// The roof: concrete deck, a parapet, the helipad with its yellow ring (the edge of the fight) and an H.
function roof(scene) {
  const concrete = mat(0x6f6a72), dark = mat(0x3b3940), paint = mat(0xf2c14e, { emissive: 0x6b4a10, emissiveIntensity: .25 }), white = mat(0xe9e6ef);
  mesh(scene, new THREE.BoxGeometry(ROOF * 2, .6, ROOF * 2), concrete, 0, -.3, 0, false);
  for (const [x, z, w, d] of [[0, -ROOF, ROOF * 2 + .6, .3], [0, ROOF, ROOF * 2 + .6, .3], [-ROOF, 0, .3, ROOF * 2], [ROOF, 0, .3, ROOF * 2]]) {
    mesh(scene, new THREE.BoxGeometry(w, 1.1, d), concrete, x, .55, z);
    mesh(scene, new THREE.BoxGeometry(w + .1, .08, d + .1), dark, x, 1.12, z);
  }
  const flat = (geometry, material, y) => { const m = mesh(scene, geometry, material, 0, y, 0, false); m.rotation.x = -Math.PI / 2; return m; };
  flat(new THREE.CircleGeometry(ARENA.radius + .9, 64), dark, .01);
  flat(new THREE.RingGeometry(ARENA.radius, ARENA.radius + .22, 96), paint, .02);
  flat(new THREE.RingGeometry(ARENA.radius + .55, ARENA.radius + .62, 96), white, .02);
  for (const [x, z, w, d] of [[-1.1, 0, .45, 3.2], [1.1, 0, .45, 3.2], [0, 0, 1.8, .45]]) {
    const bar = mesh(scene, new THREE.BoxGeometry(w, .02, d), white, x, .02, z, false); bar.receiveShadow = true;
  }
  // landing lights round the pad
  const lamp = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x6fd8ff, emissiveIntensity: 1.4 });
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    mesh(scene, new THREE.CylinderGeometry(.07, .09, .1, 10), lamp, Math.cos(a) * (ARENA.radius + 1.3), .05, Math.sin(a) * (ARENA.radius + 1.3), false);
  }
}

// Rooftop plant around the pad: air-conditioning units, a water tank on legs, the stair house with a lit door, vents,
// an antenna with a red beacon, and two lamp posts that light the pad.
function plant(scene) {
  const metal = mat(0x8c8f99, { roughness: .6, metalness: .4 }), grey = mat(0x5a5862), tank = mat(0x7d6f63);
  for (const [x, z, r] of [[-13, -11, 0], [-10.5, -13, .2], [12, 12, -.3], [13.5, 8.5, 0]]) {
    const u = mesh(scene, new THREE.BoxGeometry(2.2, 1.3, 1.6), metal, x, .65, z); u.rotation.y = r;
    const fan = mesh(scene, new THREE.CylinderGeometry(.55, .55, .05, 20), grey, x, 1.33, z); fan.rotation.y = r;
  }
  mesh(scene, new THREE.CylinderGeometry(1.5, 1.5, 2.6, 24), tank, 12.5, 3.6, -11.5);
  mesh(scene, new THREE.ConeGeometry(1.6, .8, 24), tank, 12.5, 5.3, -11.5);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mesh(scene, new THREE.BoxGeometry(.15, 2.3, .15), grey, 12.5 + dx, 1.15, -11.5 + dz);
  const house = mesh(scene, new THREE.BoxGeometry(4, 3, 3.4), mat(0x77727d), -12.5, 1.5, 11.5);
  house.rotation.y = .02;
  mesh(scene, new THREE.BoxGeometry(1.1, 2.1, .06), new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb45e, emissiveIntensity: 1.2 }), -12.5, 1.05, 9.78, false);
  for (const [x, z] of [[9, -15.5], [5, -15.5], [-15.5, 2], [-15.5, -3]]) mesh(scene, new THREE.CylinderGeometry(.25, .25, 1.4, 12), metal, x, .7, z);
  mesh(scene, new THREE.CylinderGeometry(.06, .1, 9, 8), grey, 15, 4.5, 15);
  const beacon = mesh(scene, new THREE.SphereGeometry(.18, 12, 8), new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2a1f, emissiveIntensity: 2 }), 15, 9.1, 15, false);
  arena.beacons.push(beacon);
  for (const [x, z] of [[-9.5, 9.5], [9.5, -9.5]]) {
    mesh(scene, new THREE.CylinderGeometry(.08, .1, 4.2, 10), grey, x, 2.1, z);
    mesh(scene, new THREE.SphereGeometry(.28, 14, 10), new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffd28a, emissiveIntensity: 2 }), x, 4.3, z, false);
    const light = new THREE.PointLight(0xffc58a, 18, 18, 1.6); light.position.set(x, 4.1, z); scene.add(light);
  }
}

// The city: towers around and below the roof, their windows lit at random, fading into the dusk haze.
function skyline(scene) {
  const windows = canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = '#10131f'; g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 8) for (let x = 3; x < w; x += 7) {
      const lit = Math.random();
      g.fillStyle = lit > .62 ? (lit > .9 ? '#ffe9b0' : '#f2b867') : lit > .5 ? '#3c4a6b' : '#171b2a';
      g.fillRect(x, y, 4, 5);
    }
  });
  windows.wrapS = windows.wrapT = THREE.RepeatWrapping;
  const kinds = [[7, 60, 1, 6], [10, 34, 2, 4], [16, 16, 3, 2]]; // [width, height, texture repeats across, up]
  const spot = new THREE.Object3D(), tint = new THREE.Color();
  for (const [w, h, rx, ry] of kinds) {
    const tex = windows.clone(); tex.needsUpdate = true; tex.repeat.set(rx, ry);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: .85, roughness: .8 });
    const count = 46, towers = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, w), material, count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, r = rnd(34, 170), s = rnd(.7, 1.35), tall = rnd(.6, 1.6);
      spot.position.set(Math.cos(a) * r, -DROP + h * tall / 2, Math.sin(a) * r);
      spot.scale.set(s, tall, s); spot.rotation.y = rnd(0, Math.PI); spot.updateMatrix();
      towers.setMatrixAt(i, spot.matrix);
      towers.setColorAt(i, tint.setHSL(rnd(.6, .75), .25, rnd(.45, .7)));
    }
    scene.add(towers);
  }
  const street = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), mat(0x1a1622));
  street.rotation.x = -Math.PI / 2; street.position.y = -DROP; scene.add(street);
}

function buildArena() {
  if (arena.scene) return arena;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1426);
  scene.fog = new THREE.Fog(0x4a3048, 45, 230);
  sky(scene); lights(scene); roof(scene); plant(scene); skyline(scene);
  arena.scene = scene;
  arena.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, .1, 700);
  return arena;
}

// Per frame while someone looks at it: the antenna beacon blinks.
function updateArena(dt) {
  if (!arena.scene) return;
  arena.t += dt;
  const on = arena.t % 1.4 < .25;
  for (const b of arena.beacons) b.material.emissiveIntensity = on ? 3 : .2;
}

function disposeArena() {
  if (!arena.scene) return;
  arena.scene.traverse(o => {
    if (!o.isMesh && !o.isSprite) return;
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.map?.dispose(); m.emissiveMap?.dispose(); m.dispose(); }
  });
  Object.assign(arena, { scene: null, camera: null, beacons: [], t: 0 });
}

export { arena, buildArena, disposeArena, updateArena };
