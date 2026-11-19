import * as THREE from 'three';
import { marketplaceItem, normalizeEquipment } from '../config/marketplace.js';

const bounds = new THREE.Box3(), partBounds = new THREE.Box3(), center = new THREE.Vector3(), size = new THREE.Vector3();
const worldScale = new THREE.Vector3(), offset = new THREE.Vector3(), socketRotation = new THREE.Quaternion();

function disposeGroup(group) {
  if (!group) return;
  const geometries = new Set(), materials = new Set();
  group.traverse(o => {
    if (!o.isMesh) return;
    geometries.add(o.geometry);
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) materials.add(material);
  });
  group.removeFromParent();
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}

function clearEquipment(body) {
  for (const group of body.marketLayers ?? []) disposeGroup(group);
  body.marketLayers = [];
  body.marketPet = null;
  body.marketEquipment = null;
  body.weaponTip = null; body.weaponModel = null; body.weaponColor = null;
}

function material(color, metal = false) {
  return new THREE.MeshStandardMaterial({ color, roughness: metal ? .38 : .85, metalness: metal ? .55 : 0 });
}
function mesh(group, geometry, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; group.add(m);
  return m;
}
function box(group, mat, w, h, d, x = 0, y = 0, z = 0) {
  return mesh(group, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
}
function attach(body, socket, group) {
  socket.getWorldQuaternion(group.quaternion);
  socket.attach(group);
  body.marketLayers.push(group);
}

function torsoBounds(body) {
  body.root.updateMatrixWorld(true);
  bounds.makeEmpty();
  // A world-axis box grows when the character leans. Measure unposed local geometry instead.
  for (const o of body.spine.children) if (o.isMesh) {
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    o.updateMatrix();
    bounds.union(partBounds.copy(o.geometry.boundingBox).applyMatrix4(o.matrix));
  }
  body.spine.getWorldScale(worldScale);
  if (bounds.isEmpty()) bounds.setFromCenterAndSize(center.set(0, 0, 0), size.set(.3, .3, .2).divide(worldScale));
  bounds.getCenter(center); bounds.getSize(size);
  body.spine.localToWorld(center); size.multiply(worldScale);
}
function offsetAlongSocket(group, socket, x, y, z, amount) {
  socket.getWorldQuaternion(socketRotation);
  offset.set(0, amount, 0).applyQuaternion(socketRotation);
  group.position.set(x, y, z).add(offset);
}

function outfit(body, item) {
  torsoBounds(body);
  const x = center.x, y = center.y, z = center.z, w = size.x * 1.08, h = size.y * .98, d = size.z * 1.15;
  const cloth = material(item.color), trim = material(item.accent), upper = new THREE.Group();
  upper.position.set(x, y, z);
  box(upper, cloth, w, h, d);
  box(upper, trim, w * .9, h * .08, d + .006, 0, -h * .38);
  box(upper, trim, w * .12, h * .85, .015, 0, 0, d / 2 + .006);
  attach(body, body.spine, upper);
  if (item.model === 'hoodie') { hood(body, upper, item, w, h, d); return; } // a hoodie stops at the waist
  const lower = new THREE.Group(); offsetAlongSocket(lower, body.spine, x, y, z, -h * .75);
  if (item.model === 'dress') {
    mesh(lower, new THREE.CylinderGeometry(w * .43, w * .7, h * .9, 12), material(item.color));
    mesh(lower, new THREE.CylinderGeometry(w * .69, w * .72, h * .06, 12), material(item.accent), 0, -h * .42);
  } else {
    const coat = material(item.color);
    box(lower, coat, w * .44, h * .65, d, -w * .25);
    box(lower, coat, w * .44, h * .65, d, w * .25);
  }
  attach(body, body.spine, lower);
}

// The hoodie's extras on its upper part: the hood lying on the back, a front pocket, and drawstrings.
function hood(body, upper, item, w, h, d) {
  const trim = material(item.accent), cloth = material(item.color);
  box(upper, cloth, w * .7, h * .32, d * .45, 0, h * .42, -d * .55);
  box(upper, trim, w * .55, h * .2, .012, 0, -h * .22, d / 2 + .008);
  for (const side of [-1, 1]) box(upper, trim, .012, h * .3, .012, side * w * .1, h * .25, d / 2 + .01);
}

function armor(body, item) {
  if (item.model === 'vest') { vest(body, item); return; }
  torsoBounds(body);
  const x = center.x, y = center.y, z = center.z, w = size.x + .045, h = size.y * .8, d = size.z + .05;
  const steel = material(item.color, true), trim = material(item.accent, true), plate = new THREE.Group();
  offsetAlongSocket(plate, body.spine, x, y, z, h * .06);
  box(plate, steel, w, h, d);
  const gem = mesh(plate, new THREE.OctahedronGeometry(h * .14), trim, 0, h * .13, d / 2 + .02);
  gem.scale.z = .4;
  box(plate, trim, w + .01, h * .08, d + .01, 0, -h * .4);
  attach(body, body.spine, plate);
  for (const arm of [body.armL, body.armR]) {
    const shoulder = new THREE.Group(); arm.getWorldPosition(shoulder.position);
    box(shoulder, material(item.color, true), w * .4, h * .32, d * 1.15, 0, -.015);
    box(shoulder, material(item.accent, true), w * .42, h * .06, d * 1.2, 0, h * .13);
    attach(body, arm, shoulder);
  }
}

// A padded vest: a close shell over the torso, no shoulder plates, pockets and a glowing (or plain) trim.
function vest(body, item) {
  torsoBounds(body);
  const x = center.x, y = center.y, z = center.z, w = size.x + .03, h = size.y * .78, d = size.z + .04;
  const shell = material(item.color), trim = material(item.accent), group = new THREE.Group();
  trim.emissive.set(item.accent); trim.emissiveIntensity = .35;
  offsetAlongSocket(group, body.spine, x, y, z, -h * .04);
  box(group, shell, w, h, d);
  box(group, trim, .02, h * .95, .012, 0, 0, d / 2 + .008);
  for (const side of [-1, 1]) {
    box(group, trim, w * .26, h * .2, .02, side * w * .24, -h * .2, d / 2 + .01);
    box(group, trim, w * .22, h * .06, .016, side * w * .24, h * .22, d / 2 + .009);
  }
  box(group, trim, w + .01, h * .07, d + .01, 0, -h * .46);
  attach(body, body.spine, group);
}

// A weapon in the right hand (docs/DUEL-SPEC.md, Phase 1.2). Built with the arm hanging straight down and the
// character facing +z, then attached to the hand so it follows every swing. Blades leave the fist angled forward, like a
// real grip: raised overhead the blade points back, swung down it passes through whoever is in front. Guns line up with
// the arm, so a raised arm aims them straight ahead. Each has a `tip` (blade end, hammer head, muzzle): ui/duelArena.js
// draws swing trails from it and fires bolts from it.
const cyl = (r1, r2, h, n = 10) => new THREE.CylinderGeometry(r1, r2, h, n);
const GRIP = { blade: 1.875, staff: 1.65, gun: Math.PI / 2 }; // tilt from straight up, about the hand's x axis
function weaponModel(item) {
  const g = new THREE.Group(), metal = material(item.color, true), trim = material(item.accent, true), grip = material('#2a2630');
  const glow = material(item.accent); glow.emissive.set(item.accent); glow.emissiveIntensity = 1.1;
  const tip = new THREE.Object3D(); g.add(tip);
  const blade = (len, width) => {
    mesh(g, cyl(.02, .022, .16), grip, 0, -.02, 0);
    box(g, trim, width * 3.4, .022, .05, 0, .07, 0);
    box(g, metal, width, len, .012, 0, .08 + len / 2, 0);
    box(g, glow, width * .25, len * .9, .014, 0, .08 + len / 2, 0);
    tip.position.set(0, .08 + len, 0); g.rotation.x = GRIP.blade;
  };
  switch (item.model) {
    case 'sword': blade(.62, .04); break;
    case 'greatsword': blade(.95, .075); g.scale.setScalar(1.05); break;
    case 'staff': {
      mesh(g, cyl(.018, .022, 1.45), metal, 0, .1, 0);
      const crystal = mesh(g, new THREE.OctahedronGeometry(.07), glow, 0, .88, 0); crystal.scale.y = 1.6;
      mesh(g, new THREE.TorusGeometry(.055, .012, 6, 16), trim, 0, .78, 0).rotation.x = Math.PI / 2;
      tip.position.set(0, .9, 0); g.rotation.x = GRIP.staff;
      break;
    }
    case 'hammer':
      mesh(g, cyl(.02, .024, .62), grip, 0, .2, 0);
      box(g, metal, .24, .13, .13, 0, .52, 0);
      box(g, glow, .245, .03, .135, 0, .52, 0);
      tip.position.set(0, .52, 0); g.rotation.x = GRIP.blade;
      break;
    case 'pistol': // built pointing +z (the barrel), then turned to lie along the arm
      box(g, grip, .04, .11, .05, 0, -.03, 0);
      box(g, metal, .05, .06, .2, 0, .04, .07);
      box(g, glow, .052, .015, .14, 0, .07, .08);
      mesh(g, cyl(.016, .016, .04, 10), glow, 0, .04, .19).rotation.x = Math.PI / 2;
      tip.position.set(0, .04, .22); g.rotation.x = GRIP.gun;
      break;
    case 'rifle':
      box(g, grip, .04, .1, .05, 0, -.03, 0);
      box(g, metal, .06, .08, .62, 0, .05, .16);
      box(g, metal, .05, .09, .2, 0, .02, -.2);
      for (const z of [.12, .22, .32]) mesh(g, cyl(.035, .035, .03, 12), glow, 0, .05, z).rotation.x = Math.PI / 2;
      mesh(g, cyl(.018, .018, .12, 10), glow, 0, .06, .52).rotation.x = Math.PI / 2;
      tip.position.set(0, .06, .59); g.rotation.x = GRIP.gun;
      break;
    default: blade(.6, .04);
  }
  g.userData.tip = tip;
  return g;
}
function weapon(body, item) {
  const hand = body.sockets?.rightHand ?? body.armR, arm = body.armR, g = weaponModel(item);
  // build it against the arm hanging straight down, whatever pose the character is in right now
  const pose = arm.rotation.clone(); arm.rotation.set(0, 0, 0); body.root.updateMatrixWorld(true);
  hand.getWorldPosition(g.position);
  hand.attach(g); // keeps the world pose built above
  arm.rotation.copy(pose); body.root.updateMatrixWorld(true);
  body.marketLayers.push(g);
  body.weaponTip = g.userData.tip; body.weaponModel = item.model; body.weaponColor = item.accent;
}

function makePet(item) {
  const root = new THREE.Group(), main = material(item.color), accent = material(item.accent), eyes = material('#142c38');
  root.name = 'marketPet';
  if (item.model === 'fox') {
    box(root, main, .18, .15, .26, 0, .17);
    box(root, main, .18, .16, .17, 0, .29, .12);
    box(root, accent, .1, .07, .08, 0, .255, .21);
    for (const side of [-1, 1]) {
      mesh(root, new THREE.ConeGeometry(.055, .12, 4), main, side * .065, .415, .10);
      mesh(root, new THREE.SphereGeometry(.012, 8, 6), eyes, side * .052, .31, .207);
      box(root, accent, .045, .1, .06, side * .065, .06, .08);
      box(root, main, .045, .1, .06, side * .065, .06, -.08);
    }
    const tail = mesh(root, new THREE.ConeGeometry(.075, .28, 8), accent, 0, .23, -.23);
    tail.rotation.x = -Math.PI / 3;
  } else if (item.model === 'cat') {
    box(root, main, .15, .13, .24, 0, .14);
    box(root, main, .15, .14, .13, 0, .27, .12);
    box(root, accent, .09, .05, .02, 0, .24, .19);
    for (const side of [-1, 1]) {
      const ear = mesh(root, new THREE.ConeGeometry(.035, .07, 4), main, side * .045, .37, .12); ear.rotation.y = Math.PI / 4;
      mesh(root, new THREE.SphereGeometry(.01, 8, 6), eyes, side * .038, .29, .187);
      box(root, accent, .035, .08, .04, side * .05, .04, .09);
      box(root, main, .035, .08, .04, side * .05, .04, -.08);
    }
    const tail = new THREE.Group(); tail.position.set(0, .18, -.12); root.add(tail);
    const t1 = mesh(tail, new THREE.CylinderGeometry(.018, .022, .18, 8), main, 0, .09, -.02); t1.rotation.x = -.3;
    const t2 = mesh(tail, new THREE.CylinderGeometry(.014, .018, .1, 8), accent, 0, .2, .02); t2.rotation.x = .5;
    root.userData.tail = tail;
  } else if (item.model === 'drone') {
    const glow = material(item.accent); glow.emissive.set(item.accent); glow.emissiveIntensity = .9;
    box(root, main, .16, .05, .16, 0, .5);
    box(root, glow, .05, .025, .02, 0, .5, .085);
    const rotors = [];
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      box(root, main, .12, .015, .02, dx * .07, .51, dz * .07).rotation.y = dx * dz > 0 ? Math.PI / 4 : -Math.PI / 4;
      const rotor = mesh(root, new THREE.BoxGeometry(.11, .006, .018), accent, dx * .12, .53, dz * .12);
      rotors.push(rotor);
    }
    root.userData.rotors = rotors;
    root.scale.setScalar(1.5); // big enough to read at a glance next to its owner
  } else {
    main.emissive.set(item.color); main.emissiveIntensity = .35;
    mesh(root, new THREE.SphereGeometry(.13, 20, 12), main, 0, .25);
    const halo = mesh(root, new THREE.TorusGeometry(.17, .012, 6, 32), accent, 0, .44);
    halo.rotation.x = Math.PI / 2;
    for (const side of [-1, 1]) mesh(root, new THREE.SphereGeometry(.018, 8, 6), eyes, side * .046, .27, .119);
  }
  return root;
}

function applyEquipment(body, raw) {
  clearEquipment(body);
  const equipped = normalizeEquipment(raw);
  const position = body.root.position.clone(), rotation = body.root.quaternion.clone();
  body.root.position.set(0, 0, 0); body.root.quaternion.identity();
  body.marketEquipment = equipped;
  body.root.updateMatrixWorld(true);
  if (equipped.outfit) outfit(body, marketplaceItem(equipped.outfit));
  if (equipped.armor) armor(body, marketplaceItem(equipped.armor));
  if (equipped.weapon) weapon(body, marketplaceItem(equipped.weapon));
  if (equipped.pet) {
    const pet = makePet(marketplaceItem(equipped.pet));
    pet.position.set(.55, 0, .08);
    body.root.add(pet); body.marketLayers.push(pet); body.marketPet = pet;
  }
  body.root.position.copy(position); body.root.quaternion.copy(rotation);
  body.root.updateMatrixWorld(true);
  return equipped;
}

function updateEquipment(body, time) {
  const pet = body.marketPet; if (!pet) return;
  const model = marketplaceItem(body.marketEquipment.pet)?.model;
  if (model === 'wisp') pet.position.y = .08 + Math.sin(time * 2) * .045;
  else if (model === 'drone') { pet.position.y = .1 + Math.sin(time * 2.6) * .04; for (const r of pet.userData.rotors) r.rotation.y = time * 40; }
  else pet.position.y = Math.abs(Math.sin(time * 2.4)) * .012;
  if (pet.userData.tail) pet.userData.tail.rotation.z = Math.sin(time * 3) * .35; // the cat's tail sways
  pet.rotation.y = Math.sin(time * .7) * .18;
}

export { applyEquipment, clearEquipment, disposeGroup, makePet, updateEquipment };
