import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FOV_DEG } from './constants';

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // powerPreference asks hybrid-graphics laptops for the discrete GPU instead of
  // the integrated one — a free win for a GPU-bound game on the machines a lot of
  // players are on.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Filmic tone mapping + a touch of exposure so the arena reads bright and
  // punchy instead of the old flat, murky look.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  return renderer;
}

export function createCamera(canvas: HTMLCanvasElement): THREE.PerspectiveCamera {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const cam = new THREE.PerspectiveCamera(FOV_DEG, w / h, 0.1, 1000);
  return cam;
}

// Classic three.js vertical-gradient sky dome (sky-blue zenith → pale horizon).
function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(500, 32, 15);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x4a86c8) },
      bottomColor: { value: new THREE.Color(0xdce9f4) },
      offset: { value: 30 },
      exponent: { value: 0.7 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  return sky;
}

export function createScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc0dd);
  // Light haze that fades distant geometry into the horizon colour. Far enough
  // not to murk up small duel maps.
  scene.fog = new THREE.Fog(0xb6cadb, 90, 280);

  scene.add(createSky());

  // Soft image-based fill so PBR surfaces look lit-from-everywhere and bright.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // Sky/ground hemisphere + a warm key "sun" + a cool fill. Brighter than the
  // old setup so the arena isn't murky.
  const hemi = new THREE.HemisphereLight(0xcfe2f2, 0x55504e, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
  sun.position.set(20, 40, 12);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88a6ff, 0.35);
  fill.position.set(-15, 18, -12);
  scene.add(fill);
  return scene;
}
