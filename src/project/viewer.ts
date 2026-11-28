import { AmbientLight, AnimationMixer, AxesHelper, Box3, Box3Helper, DataTexture, DirectionalLight, GridHelper, MathUtils, MOUSE, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshNormalMaterial, MeshPhongMaterial, MeshStandardMaterial, NeutralToneMapping, OrthographicCamera, PerspectiveCamera, PMREMGenerator, Raycaster,
  RepeatWrapping, Scene, SkinnedMesh, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer,
  type AnimationClip, type BufferGeometry, type Material, type Object3D, type WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Model } from './adapter';
import { isMatcapLook, matcapMaterial, matcapTexture, pbrMaterial, shaderLook, type MatcapLook, type ShaderLook } from './display-material';
import { applyViews, disposeAppearance, emptyAppearance, sourceAppearance, unlitColor, type Appearance } from '../texture/appearance';
import { sourceImage, type TextureCatalog, type TextureTarget } from '../texture/bindings';
import { addFbxPbrMaps } from '../texture/preview-pbr';
import { atlasColor, type WorkingState } from './state';

export type DisplayMode = 'textured' | 'pbr' | 'unlit' | 'solid' | 'wire' | 'edges' | 'checker' | 'normals' | ShaderLook | MatcapLook;
export type CompareMode = 'working' | 'reference' | 'split';
type ReferenceView = { root: Object3D; appearance?: Appearance };
const verticalFov = 40;
const frameSlope = Math.tan(MathUtils.degToRad(verticalFov / 2));

function checkerMaterial() {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x % 8 === 0 || y % 8 === 0 ? [63, 149, 153, 255]
      : ((x >> 3) + (y >> 3)) % 2 ? [210, 224, 224, 255] : [42, 61, 76, 255];
    pixels.set(a, 4 * (y * size + x));
  }
  const map = new DataTexture(pixels, size, size);
  map.wrapS = map.wrapT = RepeatWrapping;
  map.colorSpace = SRGBColorSpace;
  map.needsUpdate = true;
  return new MeshBasicMaterial({ map });
}

export class Viewer {
  readonly scene = new Scene();
  #renderer: WebGLRenderer | null;
  #canvas: HTMLCanvasElement;
  #framingAspect: number;
  #viewportAspect: number;
  #frameHalfHeight = 1;
  #fixedBuffer: boolean;
  #compare: CompareMode = 'working';
  #reference?: ReferenceView;
  #referenceScene = new Scene();
  #referenceAmbient = new AmbientLight(0xffffff, 1.5);
  #referenceKey = new DirectionalLight(0xffffff, 2);
  #referenceGrid = new GridHelper(10, 20, 0x526c80, 0x2b4051);
  #referenceAxes = new AxesHelper(1);
  #referenceBounds = new Box3Helper(new Box3(), 0x708fa2);
  #isolated?: ReadonlySet<Object3D>;
  #areaSelecting = false;
  #model?: Object3D;
  #camera?: PerspectiveCamera | OrthographicCamera;
  #orbit?: OrbitControls;
  #appearance?: Appearance;
  #live?: Appearance;
  #inspection?: { mesh: Mesh; geometry: BufferGeometry };
  #skinView?: { mesh: Mesh; geometry: BufferGeometry; material: Material };
  #outline = new Box3Helper(new Box3(), 0x2ad9ed);
  #floor = new GridHelper(10, 20, 0x526c80, 0x2b4051);
  #axes = new AxesHelper(1);
  #cursor = new AxesHelper(.1);
  #bounds = new Box3Helper(new Box3(), 0x708fa2);
  #ambient = new AmbientLight(0xffffff, 1.5);
  #keyLight = new DirectionalLight(0xffffff, 2);
  #studio?: WebGLRenderTarget;
  #display: DisplayMode = 'textured';
  #materials = {
    solid: new MeshStandardMaterial({ color: 0x9badbf, roughness: .76 }),
    normals: new MeshNormalMaterial(),
    checker: checkerMaterial(),
    wire: new MeshBasicMaterial({ color: 0xa0eadb, wireframe: true }),
    edges: new MeshBasicMaterial({ color: 0xa0eadb, wireframe: true, transparent: true, opacity: .75, depthWrite: false }),
  };
  #materialSides = new Map<string, Material>();
  #painting = false;
  #paintingStroke = false;
  #pose?: { clip: AnimationClip; time: number };
  #mixers = new WeakMap<AnimationClip, AnimationMixer>();
  #manualPose?: () => () => void;
  #previewUnlit = false;
  #displayMaterials = new Map<string, Material>();
  #matcaps = new Map<MatcapLook, Texture>();
  onPoseRender?: () => void;
  #cameraListeners = new Set<() => void>();
  #contextLost = false;

  constructor(canvas: HTMLCanvasElement, onContext: (lost: boolean) => void) {
    this.#canvas = canvas;
    this.#framingAspect = this.#viewportAspect = canvas.width / canvas.height;
    this.#fixedBuffer = canvas.hasAttribute('data-fixed-buffer');
    const context = canvas.getContext('webgl2', { antialias: true });
    this.#renderer = context ? new WebGLRenderer({ canvas, context }) : null;
    this.#renderer?.setClearColor(0x19232e);
    this.#keyLight.position.set(3, 5, 4);
    this.#referenceKey.position.copy(this.#keyLight.position);
    this.#referenceScene.add(this.#referenceAmbient, this.#referenceKey, this.#referenceGrid, this.#referenceAxes, this.#referenceBounds);
    this.scene.add(this.#ambient, this.#keyLight, this.#floor, this.#axes, this.#bounds, this.#outline, this.#cursor);
    this.#bounds.visible = this.#axes.visible = this.#outline.visible = this.#cursor.visible = false;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.#contextLost = true;
      this.#studio?.dispose();
      this.#studio = undefined;
      onContext(true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.#contextLost = false;
      this.resize();
      this.render();
      onContext(false);
    });
  }

  get camera() { return this.#camera; }
  get available() { return !!this.#renderer && !this.#contextLost; }
  get comparing() { return this.#compare !== 'working'; }
  get isolated() { return this.#isolated; }

  onCameraChange(listener: () => void) { this.#cameraListeners.add(listener); }

  resize() {
    if (!this.#renderer || this.#contextLost) return;
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const aspect = rect.width / rect.height, changed = aspect !== this.#viewportAspect;
    this.#viewportAspect = aspect;
    const reprojected = this.#updateProjection();
    let resized = false;
    if (!this.#fixedBuffer) {
      const scale = Math.min(devicePixelRatio, 2, 4096 / Math.max(rect.width, rect.height));
      const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
      resized = width !== this.#canvas.width || height !== this.#canvas.height;
      if (resized) this.#renderer.setSize(width, height, false);
    }
    const cursor = document.getElementById('paint-cursor') as HTMLCanvasElement;
    if (cursor.width !== this.#canvas.width || cursor.height !== this.#canvas.height) {
      cursor.width = this.#canvas.width;
      cursor.height = this.#canvas.height;
    }
    if (!resized && !reprojected && !changed) return;
    for (const listener of this.#cameraListeners) listener();
    this.render();
  }

  #updateProjection() {
    const camera = this.#camera;
    if (!camera) return false;
    const aspect = this.#viewportAspect / (this.#compare === 'split' ? 2 : 1);
    // Widen a landscape view and extend a narrow view vertically while keeping the target and zoom.
    const fit = Math.max(1, this.#framingAspect / aspect);
    if (camera instanceof PerspectiveCamera) {
      const fov = fit === 1 ? verticalFov : MathUtils.radToDeg(2 * Math.atan(frameSlope * fit));
      if (camera.aspect === aspect && camera.fov === fov) return false;
      camera.aspect = aspect;
      camera.fov = fov;
    } else {
      const height = this.#frameHalfHeight * fit, width = height * aspect;
      if (camera.right === width && camera.top === height) return false;
      camera.left = -width;
      camera.right = width;
      camera.top = height;
      camera.bottom = -height;
    }
    camera.updateProjectionMatrix();
    return true;
  }

  setDisplay(mode: DisplayMode) {
    this.#display = mode;
    this.render();
  }

  setGuides(grid: boolean, axes: boolean, bounds: boolean) {
    this.#floor.visible = grid;
    this.#axes.visible = axes;
    this.#bounds.visible = bounds;
    this.render();
  }

  setLighting(exposure: number, background: string) {
    const multiplier = 2 ** Math.max(-4, Math.min(4, exposure));
    this.#ambient.intensity = 1.5 * multiplier;
    this.#keyLight.intensity = 2 * multiplier;
    this.#referenceAmbient.intensity = this.#ambient.intensity;
    this.#referenceKey.intensity = this.#keyLight.intensity;
    this.#renderer?.setClearColor(background);
    (this.#canvas.closest('.model-stage') as HTMLElement | null)?.style.setProperty('--stage-background', background);
    this.render();
  }

  compare(mode: CompareMode, reference?: ReferenceView) {
    this.#compare = reference ? mode : 'working';
    if (reference !== this.#reference) {
      this.#reference?.root.removeFromParent();
      this.#reference = reference;
      if (reference) {
        this.#referenceScene.add(reference.root);
        this.#referenceBounds.box.setFromObject(reference.root);
      }
      this.#clearDisplayMaterials();
      this.#renderer?.renderLists.dispose();
    }
    const container = this.#canvas.parentElement!;
    if (this.comparing) container.dataset.compare = this.#compare;
    else delete container.dataset.compare;
    this.#configureOrbit();
    this.resize();
    this.render();
  }

  isolate(objects?: readonly Object3D[]) {
    this.#isolated = objects?.length ? new Set(objects) : undefined;
    this.render();
  }

  areaSelection(enabled: boolean) { this.#areaSelecting = enabled; this.#configureOrbit(); }

  showCursor(position?: Vector3) {
    const visible = !!position?.toArray().every(Number.isFinite);
    if (visible === this.#cursor.visible && (!visible || position!.equals(this.#cursor.position))) return;
    this.#cursor.visible = visible;
    if (visible) this.#cursor.position.copy(position!);
    this.render();
  }

  measureGuides() {
    if (!this.#model) return;
    const box = this.#bounds.box.setFromObject(this.#model);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3()), diameter = Math.max(.001, box.getSize(new Vector3()).length());
    const size = 10 ** Math.ceil(Math.log10(diameter * 1.4));
    this.#floor.scale.setScalar(size / 10);
    this.#floor.position.set(center.x, box.min.y, center.z);
    this.#axes.position.copy(this.#floor.position);
    this.#axes.scale.setScalar(diameter * .3);
    this.#cursor.scale.setScalar(diameter * .4);
  }

  install(model: Object3D, appearance?: Appearance) {
    this.close();
    this.#model = model;
    this.scene.add(model);
    this.#appearance = appearance;
    if (!this.#renderer) return;
    this.#canvas.hidden = false;
    this.measureGuides();
    this.frame();
  }

  close() {
    this.#orbit?.dispose();
    this.#orbit = undefined;
    this.#camera = undefined;
    this.#model?.removeFromParent();
    this.#model = undefined;
    this.#inspection = undefined;
    this.#isolated = undefined;
    this.#skinView = undefined;
    this.#pose = undefined;
    this.#mixers = new WeakMap();
    this.#manualPose = undefined;
    this.#previewUnlit = false;
    this.#clearDisplayMaterials();
    for (const texture of this.#matcaps.values()) texture.dispose();
    this.#matcaps.clear();
    this.#studio?.dispose();
    this.#studio = undefined;
    this.onPoseRender = undefined;
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#appearance = undefined;
    this.setLive();
    this.#outline.visible = this.#cursor.visible = false;
    this.#canvas.hidden = true;
    this.#renderer?.renderLists.dispose();
    this.#renderer?.clear();
  }

  replaceAppearance(appearance?: Appearance) {
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#clearDisplayMaterials();
    this.#appearance = appearance;
  }

  setLive(appearance?: Appearance) {
    if (this.#live) {
      disposeAppearance(this.#live);
      this.#clearDisplayMaterials();
    }
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

  skinView(view?: { mesh: Mesh; geometry: BufferGeometry; material: Material }) { this.#skinView = view; }

  setPainting(active: boolean, stroke = false) {
    this.#painting = active;
    this.#paintingStroke = stroke;
    this.#configureOrbit();
  }

  #configureOrbit() {
    if (!this.#orbit) return;
    this.#orbit.enabled = !this.#paintingStroke;
    this.#orbit.mouseButtons.LEFT = (this.#painting || this.#areaSelecting) && !this.comparing ? null : MOUSE.ROTATE;
    this.#orbit.mouseButtons.MIDDLE = MOUSE.PAN;
    this.#orbit.mouseButtons.RIGHT = MOUSE.ROTATE;
    this.#orbit.enableRotate = true;
  }

  freeze(clip?: AnimationClip, time = 0) {
    this.#pose = clip && { clip, time };
    this.render();
  }

  manualPose(apply?: () => () => void) { this.#manualPose = apply; }

  previewUnlit(value: boolean) { this.#previewUnlit = value; }

  withPose<T>(use: () => T): T {
    if (this.#manualPose) {
      const restore = this.#manualPose();
      try { return use(); } finally { restore(); }
    }
    return this.#pose ? this.samplePose(this.#pose.clip, this.#pose.time, use) : use();
  }

  samplePose<T>(clip: AnimationClip, time: number, use: () => T): T {
    if (!this.#model) return use();
    const root = this.#model;
    let mixer = this.#mixers.get(clip);
    if (!mixer) { mixer = new AnimationMixer(root); this.#mixers.set(clip, mixer); }
    const action = mixer.clipAction(clip).reset().play();
    action.paused = true;
    action.time = time;
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
    this.#frameBox(box, orthographic, direction);
  }

  focus(points: readonly Vector3[]) {
    if (!points.length || !this.#renderer) return;
    const box = new Box3().setFromPoints([...points]);
    const size = this.#model ? this.withPose(() => new Box3().setFromObject(this.#model!).getSize(new Vector3()).length()) : 1;
    box.expandByScalar(Math.max(.001, size * .015));
    const direction = this.#camera?.getWorldDirection(new Vector3()).negate() ?? new Vector3(.6, .45, 1);
    this.#frameBox(box, this.#camera instanceof OrthographicCamera, direction);
  }

  frameSelection(objects: readonly Object3D[], orthographic: boolean, direction: Vector3) {
    const box = this.withPose(() => {
      const result = new Box3();
      for (const object of objects) result.expandByObject(object, !!(this.#pose || this.#manualPose));
      return result;
    });
    this.#frameBox(box, orthographic, direction);
  }

  #frameBox(box: Box3, orthographic: boolean, direction: Vector3) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3()), radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.001);
    const height = this.#frameHalfHeight = 3.5 * radius * frameSlope;
    this.#orbit?.dispose();
    const camera = orthographic
      ? new OrthographicCamera(-height, height, height, -height, radius / 100, radius * 100)
      : new PerspectiveCamera(verticalFov, 1, radius / 100, radius * 100);
    camera.position.copy(center).addScaledVector(direction.normalize(), 3.5 * radius);
    camera.lookAt(center);
    this.#camera = camera;
    this.#updateProjection();
    this.#orbit = new OrbitControls(camera, this.#canvas);
    this.#orbit.target.copy(center);
    this.#configureOrbit();
    this.#orbit.addEventListener('change', () => {
      this.render();
      for (const listener of this.#cameraListeners) listener();
    });
    this.#orbit.update();
    this.render();
  }

  select(objects: readonly Object3D[] = []) {
    this.#outline.visible = objects.some(shown);
    this.#outline.box.makeEmpty();
    if (this.#outline.visible) this.withPose(() => {
      for (const object of objects.filter(shown)) this.#outline.box.expandByObject(object, !!(this.#pose || this.#manualPose));
    });
    this.render();
  }

  pick(event: PointerEvent, meshes: Mesh[]) { return this.hit(event, meshes)?.object; }

  hit(event: PointerEvent, meshes: Mesh[]) {
    if (!this.#camera || this.comparing) return;
    const bounds = this.#canvas.getBoundingClientRect();
    const uv = new Vector2(2 * (event.clientX - bounds.left) / bounds.width - 1,
      1 - 2 * (event.clientY - bounds.top) / bounds.height);
    const ray = new Raycaster();
    ray.setFromCamera(uv, this.#camera);
    return this.withPose(() => ray.intersectObjects(meshes.filter(mesh => shown(mesh) && this.inIsolation(mesh)), false)[0]);
  }

  inIsolation(object: Object3D) {
    if (!this.#isolated) return true;
    for (let node: Object3D | null = object; node; node = node.parent) if (this.#isolated.has(node)) return true;
    return false;
  }

  render() {
    if (!this.#renderer || !this.#camera || this.#contextLost) return;
    const renderer = this.#renderer;
    if (!this.#studio && this.#display === 'pbr' && (!this.#previewUnlit || this.comparing)) {
      const generator = new PMREMGenerator(renderer), room = new RoomEnvironment();
      try { this.#studio = generator.fromScene(room, .055, .1, 100, { size: 128 }); }
      finally { room.dispose(); generator.dispose(); }
    }
    const restore = applyViews((this.#live ?? this.#appearance)?.views ?? []);
    const display = this.#previewUnlit ? 'unlit' : this.#display;
    const clearDisplay = this.#applyDisplay(this.#model, display);
    const restoreSkin = this.#skinView && applyViews([this.#skinView]);
    const inspection = this.#inspection, masked: [Mesh, number][] = [];
    const geometry = inspection?.mesh.geometry;
    if (inspection) inspection.mesh.geometry = inspection.geometry;
    if (inspection || this.#isolated) {
      this.#model?.traverse(node => {
        if (node instanceof Mesh && (inspection && node !== inspection.mesh || !this.inIsolation(node))) {
          masked.push([node, node.layers.mask]);
          node.layers.mask = 0;
        }
      });
    }
    const drawWorking = () => this.withPose(() => {
      this.onPoseRender?.();
      this.#draw(this.scene, this.#model, display);
    });
    try {
      if (this.#compare === 'reference') this.#drawReference();
      else if (this.#compare === 'split') {
        const { x: width, y: height } = renderer.getSize(new Vector2()), half = Math.floor(width / 2);
        renderer.setScissorTest(true);
        renderer.setViewport(0, 0, half, height);
        renderer.setScissor(0, 0, half, height);
        this.#drawReference();
        renderer.setViewport(half, 0, width - half, height);
        renderer.setScissor(half, 0, width - half, height);
        drawWorking();
      } else drawWorking();
    } finally {
      if (this.#compare === 'split') {
        const size = renderer.getSize(new Vector2());
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, size.x, size.y);
      }
      if (inspection && geometry) inspection.mesh.geometry = geometry;
      for (const [mesh, mask] of masked) mesh.layers.mask = mask;
      restoreSkin?.();
      clearDisplay?.();
      restore();
    }
  }

  #drawReference() {
    if (!this.#reference) return;
    const { root, appearance } = this.#reference;
    this.#referenceGrid.visible = this.#floor.visible;
    this.#referenceGrid.position.copy(this.#floor.position);
    this.#referenceGrid.scale.copy(this.#floor.scale);
    this.#referenceAxes.visible = this.#axes.visible;
    this.#referenceAxes.position.copy(this.#axes.position);
    this.#referenceAxes.scale.copy(this.#axes.scale);
    this.#referenceBounds.visible = this.#bounds.visible;
    const restore = applyViews(appearance?.views ?? []);
    const clear = this.#applyDisplay(root, this.#display);
    try { this.#draw(this.#referenceScene, root, this.#display); }
    finally { clear?.(); restore(); }
  }

  #draw(scene: Scene, model: Object3D | undefined, display: DisplayMode) {
    const renderer = this.#renderer!, camera = this.#camera!;
    if (display === 'pbr' && this.#studio) {
      const { toneMapping } = renderer, { environment, environmentIntensity } = scene;
      renderer.toneMapping = NeutralToneMapping;
      scene.environment = this.#studio.texture;
      scene.environmentIntensity = this.#keyLight.intensity * .35;
      try { renderer.render(scene, camera); }
      finally { renderer.toneMapping = toneMapping; scene.environment = environment; scene.environmentIntensity = environmentIntensity; }
    } else renderer.render(scene, camera);
    if (display !== 'edges' || !model) return;
    const previous = renderer.autoClear;
    const clear = this.#applyDisplay(model, display, true);
    try {
      renderer.autoClear = false;
      renderer.render(model, camera);
    } finally {
      renderer.autoClear = previous;
      clear?.();
    }
  }

  #clearDisplayMaterials() {
    for (const material of this.#displayMaterials.values()) material.dispose();
    this.#displayMaterials.clear();
  }

  #applyDisplay(root: Object3D | undefined, mode: DisplayMode, overlay = false) {
    if (mode === 'textured' || mode === 'edges' && !overlay) return;
    const views: { mesh: Mesh; material: Material | Material[] }[] = [];
    const materialFor = (material: Material) => {
      if (mode === 'solid' || mode === 'normals' || mode === 'checker' || mode === 'wire' || mode === 'edges') {
        const base = this.#materials[mode];
        if (base.side === material.side) return base;
        const id = `${mode}/${material.side}`;
        let sided = this.#materialSides.get(id);
        if (!sided) {
          sided = base.clone();
          sided.side = material.side;
          this.#materialSides.set(id, sided);
        }
        return sided;
      }
      if (mode === 'pbr' && material instanceof MeshStandardMaterial) return material;
      const id = `${mode}/${material.id}`;
      let result = this.#displayMaterials.get(id);
      if (!result) {
        if (mode === 'unlit') {
          const source = material as Material & { color?: MeshBasicMaterial['color']; map?: Texture | null };
          const basic = unlitColor(material, source.map ?? null);
          if (source.color) basic.color.copy(source.color);
          result = basic;
        } else if (mode === 'pbr') result = pbrMaterial(material);
        else if (isMatcapLook(mode)) {
          let capture = this.#matcaps.get(mode);
          if (!capture) {
            capture = matcapTexture(mode);
            this.#matcaps.set(mode, capture);
          }
          result = matcapMaterial(material, capture);
        } else result = shaderLook(material, mode);
        this.#displayMaterials.set(id, result);
      }
      return result;
    };
    root?.traverse(node => {
      if (node instanceof Mesh) views.push({ mesh: node, material: Array.isArray(node.material) ? node.material.map(materialFor) : materialFor(node.material) });
    });
    return applyViews(views);
  }
}

function shown(object: Object3D): boolean {
  for (let value: Object3D | null = object; value; value = value.parent) if (!value.visible) return false;
  return true;
}

export async function prepareAppearance(model: Model, catalog: TextureCatalog, state: WorkingState,
  live?: { target: TextureTarget; canvas: HTMLCanvasElement }, unlit = false, display: DisplayMode = 'textured'): Promise<Appearance> {
  const appearance = await prepareSurface(model, catalog, state, live, unlit);
  try {
    if (model.format === 'fbx' && display === 'pbr' && !unlit) await addFbxPbrMaps(appearance, catalog, state, live);
    return appearance;
  } catch (error) {
    disposeAppearance(appearance);
    throw error;
  }
}

async function prepareSurface(model: Model, catalog: TextureCatalog, state: WorkingState,
  live: { target: TextureTarget; canvas: HTMLCanvasElement } | undefined, unlit: boolean): Promise<Appearance> {
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
  const liveColor = live?.target.atlas && !live.target.binding.semantic ? live.canvas : undefined;
  try {
    for (const entry of model.textureBake.maps) {
      if (entry.slot !== 'map' && (entry.slot !== 'normalMap' || !(material instanceof MeshPhongMaterial))) continue;
      if (entry.slot === 'map' && (edited || liveColor)) {
        const texture = new Texture(liveColor ?? sourceImage(edited!));
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
