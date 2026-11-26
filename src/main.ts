import { BoxGeometry, Mesh, MeshNormalMaterial, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
const status = document.getElementById('status');

if (!canvas || !status) {
  throw new Error('The WebGL2 check requires a canvas and status message.');
}

const context = canvas.getContext('webgl2', { antialias: true });

if (context) {
  const renderer = new WebGLRenderer({ canvas, context });
  renderer.setClearColor(0x151b25);

  const scene = new Scene();
  const cube = new Mesh(new BoxGeometry(), new MeshNormalMaterial());
  scene.add(cube);

  const camera = new PerspectiveCamera(40, canvas.width / canvas.height, 0.1, 100);
  camera.position.set(2, 1.4, 2.7);
  camera.lookAt(cube.position);

  renderer.render(scene, camera);
  canvas.hidden = false;
  status.textContent = 'WebGL2 is ready. The scene below verifies local rendering.';
} else {
  status.textContent = 'WebGL2 is unavailable in this browser. Try Chrome or Edge with graphics acceleration enabled.';
}
