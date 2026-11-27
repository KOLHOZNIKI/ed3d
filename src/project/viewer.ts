import { AmbientLight, AnimationMixer, Box3, Box3Helper, DirectionalLight, MOUSE, Mesh, MeshLambertMaterial, MeshPhongMaterial, OrthographicCamera,
  PerspectiveCamera, Raycaster, Scene, SkinnedMesh, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer,
  type AnimationClip, type BufferGeometry, type Material, type Object3D } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Model } from './adapter';
import { applyViews, disposeAppearance, emptyAppearance, sourceAppearance, unlitColor, type Appearance } from '../texture/appearance';
import { sourceImage, type TextureCatalog, type TextureTarget } from '../texture/bindings';
import { atlasColor, type WorkingState } from './state';

export class Viewer {
  readonly scene = new Scene();
  #renderer: WebGLRenderer | null;
  #canvas: HTMLCanvasElement;
  #model?: Object3D;
  #camera?: PerspectiveCamera | OrthographicCamera;
  #orbit?: OrbitControls;
  #appearance?: Appearance;
  #live?: Appearance;
  #inspection?: { mesh: Mesh; geometry: BufferGeometry };
  #outline = new Box3Helper(new Box3(), 0x2ad9ed);
  #painting = false;
  #paintingStroke = false;
  #pose?: { clip: AnimationClip; time: number };
  #manualPose?: () => () => void;
  onCameraChange?: () => void;
  #contextLost = false;

  constructor(canvas: HTMLCanvasElement, onContext: (lost: boolean) => void) {
    this.#canvas = canvas;
    const context = canvas.getContext('webgl2', { antialias: true });
    this.#renderer = context ? new WebGLRenderer({ canvas, context }) : null;
    this.#renderer?.setClearColor(0x151b25);
    this.scene.add(new AmbientLight(0xffffff, 1.5));
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(3, 5, 4);
    this.scene.add(light, this.#outline);
    this.#outline.visible = false;
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.#contextLost = true;
      onContext(true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.#contextLost = false;
      this.render();
      onContext(false);
    });
  }

  get camera() { return this.#camera; }
  get available() { return !!this.#renderer && !this.#contextLost; }

  install(model: Object3D, appearance?: Appearance) {
    this.close();
    this.#model = model;
    this.scene.add(model);
    this.#appearance = appearance;
    if (!this.#renderer) return;
    this.#canvas.hidden = false;
    this.frame();
  }

  close() {
    this.#orbit?.dispose();
    this.#orbit = undefined;
    this.#camera = undefined;
    this.#model?.removeFromParent();
    this.#model = undefined;
    this.#inspection = undefined;
    this.#pose = undefined;
    this.#manualPose = undefined;
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#appearance = undefined;
    this.setLive();
    this.#outline.visible = false;
    this.#canvas.hidden = true;
    this.#renderer?.renderLists.dispose();
    this.#renderer?.clear();
  }

  replaceAppearance(appearance?: Appearance) {
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#appearance = appearance;
  }

  setLive(appearance?: Appearance) {
    if (this.#live) disposeAppearance(this.#live);
    this.#live = appearance;
  }

  updateLive() {
    for (const texture of this.#live?.textures ?? []) texture.needsUpdate = true;
    this.render();
  }

  inspect(mesh?: Mesh, geometry?: BufferGeometry) {
    this.#inspection = mesh && geometry ? { mesh, geometry } : undefined;
    this.render();
  }

  setPainting(active: boolean, stroke = false) {
    this.#painting = active;
    this.#paintingStroke = stroke;
    this.#configureOrbit();
  }

  #configureOrbit() {
    if (!this.#orbit) return;
    this.#orbit.enabled = !this.#paintingStroke;
    this.#orbit.mouseButtons.LEFT = this.#painting ? null : MOUSE.ROTATE;
    this.#orbit.mouseButtons.RIGHT = this.#painting ? MOUSE.ROTATE : MOUSE.PAN;
    this.#orbit.enableRotate = true;
  }

  freeze(clip?: AnimationClip, time = 0) {
    this.#pose = clip && { clip, time };
    this.render();
  }

  manualPose(apply?: () => () => void) { this.#manualPose = apply; }

  withPose<T>(use: () => T): T {
    if (this.#manualPose) {
      const restore = this.#manualPose();
      try { return use(); } finally { restore(); }
    }
    if (!this.#pose || !this.#model) return use();
    const root = this.#model;
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(this.#pose.clip);
    action.paused = true;
    action.time = this.#pose.time;
    action.play();
    mixer.update(0);
    root.updateMatrixWorld(true);
    try {
      return use();
    } finally {
      mixer.stopAllAction();
      root.updateMatrixWorld(true);
    }
  }

  frame(object = this.#model, orthographic = this.#camera instanceof OrthographicCamera, direction = new Vector3(0.6, 0.45, 1)) {
    if (!object || !this.#renderer) return;
    const box = this.withPose(() => new Box3().setFromObject(object, !!(this.#pose || this.#manualPose)));
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3()), radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.001);
    const aspect = this.#canvas.width / this.#canvas.height;
    const height = 3.5 * radius * Math.tan(20 * Math.PI / 180);
    this.#orbit?.dispose();
    const camera = orthographic
      ? new OrthographicCamera(-height * aspect, height * aspect, height, -height, radius / 100, radius * 100)
      : new PerspectiveCamera(40, aspect, radius / 100, radius * 100);
    camera.position.copy(center).addScaledVector(direction.normalize(), 3.5 * radius);
    camera.lookAt(center);
    this.#camera = camera;
    this.#orbit = new OrbitControls(camera, this.#canvas);
    this.#orbit.target.copy(center);
    this.#configureOrbit();
    this.#orbit.addEventListener('change', () => { this.render(); this.onCameraChange?.(); });
    this.#orbit.update();
    this.render();
  }

  select(object?: Object3D) {
    this.#outline.visible = !!object && shown(object);
    if (this.#outline.visible) this.withPose(() => this.#outline.box.setFromObject(object!, !!(this.#pose || this.#manualPose)));
    this.render();
  }

  pick(event: PointerEvent, meshes: Mesh[]) {
    if (!this.#camera) return;
    const bounds = this.#canvas.getBoundingClientRect();
    const uv = new Vector2(2 * (event.clientX - bounds.left) / bounds.width - 1,
      1 - 2 * (event.clientY - bounds.top) / bounds.height);
    const ray = new Raycaster();
    ray.setFromCamera(uv, this.#camera);
    return ray.intersectObjects(meshes.filter(shown), false)[0]?.object;
  }

  render() {
    if (!this.#renderer || !this.#camera || this.#contextLost) return;
    const restore = applyViews((this.#live ?? this.#appearance)?.views ?? []);
    const inspection = this.#inspection, masked: [Mesh, number][] = [];
    const geometry = inspection?.mesh.geometry;
    if (inspection) {
      inspection.mesh.geometry = inspection.geometry;
      this.#model?.traverse(node => {
        if (node instanceof Mesh && node !== inspection.mesh) {
          masked.push([node, node.layers.mask]);
          node.layers.mask = 0;
        }
      });
    }
    try {
      this.withPose(() => this.#renderer!.render(this.scene, this.#camera!));
    } finally {
      if (inspection && geometry) inspection.mesh.geometry = geometry;
      for (const [mesh, mask] of masked) mesh.layers.mask = mask;
      restore();
    }
  }
}

function shown(object: Object3D): boolean {
  for (let value: Object3D | null = object; value; value = value.parent) if (!value.visible) return false;
  return true;
}

export async function prepareAppearance(model: Model, catalog: TextureCatalog, state: WorkingState,
  live?: { target: TextureTarget; canvas: HTMLCanvasElement }, unlit = false): Promise<Appearance> {
  if (model.format !== 'fbx' || !model.uvAtlas || !model.textureBake) return sourceAppearance(catalog, state, 'preview', live, unlit).appearance;
  const mesh = model.scene.getObjectByProperty('isMesh', true);
  const source = mesh instanceof Mesh ? mesh.material : undefined;
  const appearance = emptyAppearance();
  if (!(mesh instanceof Mesh) || !(source instanceof MeshLambertMaterial || source instanceof MeshPhongMaterial)) return appearance;
  const material = source.clone(), geometry = model.uvAtlas.geometry.clone();
  geometry.setAttribute('uv', geometry.getAttribute('uv1'));
  appearance.views.push({ mesh, geometry, material });
  appearance.geometries.push(geometry);
  appearance.materials.push(material);
  const edited = state.textures?.[atlasColor]?.image;
  try {
    for (const entry of model.textureBake.maps) {
      if (entry.slot !== 'map' && (entry.slot !== 'normalMap' || !(material instanceof MeshPhongMaterial))) continue;
      if (entry.slot === 'map' && (edited || live?.target.atlas)) {
        const texture = new Texture(live?.target.atlas ? live.canvas : sourceImage(edited!));
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
        appearance.textures.push(texture);
        material.map = texture;
        continue;
      }
      const png = entry.slot === 'map' ? model.texturePaint?.png ?? entry.png : entry.png;
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const texture = new Texture(image);
        texture.needsUpdate = true;
        appearance.textures.push(texture);
        if (entry.slot === 'map') {
          texture.colorSpace = SRGBColorSpace;
          material.map = texture;
        } else if (material instanceof MeshPhongMaterial) material.normalMap = texture;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (unlit) {
      const basic = unlitColor(material, material.map);
      appearance.materials.push(basic);
      appearance.views[0].material = basic;
    }
    return appearance;
  } catch (error) {
    disposeAppearance(appearance);
    throw error;
  }
}

export function disposeModel(model: Model) {
  model.scene.removeFromParent();
  const textures = new Set<Texture>(), materials = new Set<Material>(), geometries = new Set<BufferGeometry>();
  const bitmaps = new Set<ImageBitmap>(), skeletons = new Set<SkinnedMesh['skeleton']>();
  model.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const property of Object.values(material)) if (property instanceof Texture) textures.add(property);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    if (texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}
