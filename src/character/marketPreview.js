import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyEquipment, updateEquipment } from './equipment.js';
import { buildBody, disposeBody } from './rig.js';

function makeMarketPreview(host, spec) {
  let renderer, camera, controls, body, pedestal, observer;
  let frame, active = false, destroyed = false, previous = 0, time = 0;
  const scene = new THREE.Scene();
  function resize() {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix();
  }
  function tick(now) {
    if (!active || destroyed) return;
    const dt = previous ? Math.min(.05, (now - previous) / 1000) : 0; previous = now; time += dt;
    body.neck.rotation.y = Math.sin(time * .6) * .08;
    updateEquipment(body, time);
    controls.update(); renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  }
  function start() {
    if (destroyed || active) return;
    active = true; previous = 0; resize(); frame = requestAnimationFrame(tick);
  }
  function stop() { active = false; cancelAnimationFrame(frame); }
  function dispose() {
    if (destroyed) return;
    destroyed = true; stop(); observer?.disconnect(); controls?.dispose();
    if (body) disposeBody(body);
    if (pedestal) { pedestal.geometry.dispose(); pedestal.material.dispose(); }
    scene.clear();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }
  }
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-label', 'Your character and cosmetic equipment. Drag to rotate.');
    renderer.domElement.setAttribute('role', 'img');
    host.prepend(renderer.domElement);
    camera = new THREE.PerspectiveCamera(32, 1, .1, 30);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x91a2b5, 2.3));
    const key = new THREE.DirectionalLight(0xfff4e3, 3); key.position.set(3, 5, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0x8cc8ed, 1.8); rim.position.set(-3, 3, -3); scene.add(rim);
    body = buildBody(spec); scene.add(body.root); body.root.visible = true;
    const bounds = new THREE.Box3().setFromObject(body.root), height = bounds.max.y;
    camera.position.set(2.2, height * .7, 3.8);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(.12, height * .46, 0);
    controls.enablePan = false; controls.enableDamping = true;
    controls.minDistance = 1.8; controls.maxDistance = 5.5; controls.maxPolarAngle = Math.PI * .56;
    pedestal = new THREE.Mesh(new THREE.CylinderGeometry(.65, .7, .08, 48), new THREE.MeshStandardMaterial({ color: '#bacbd1', roughness: .9 }));
    pedestal.position.y = -.05; scene.add(pedestal);
    observer = new ResizeObserver(resize); observer.observe(host);
  } catch (error) { dispose(); throw error; }
  return { start, stop, dispose, equip: equipment => applyEquipment(body, equipment) };
}

export { makeMarketPreview };
