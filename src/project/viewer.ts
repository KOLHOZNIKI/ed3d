import { AmbientLight, Box3, Box3Helper, DirectionalLight, Mesh, MeshLambertMaterial, MeshPhongMaterial, OrthographicCamera,
  PerspectiveCamera, Raycaster, Scene, SkinnedMesh, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer,
  type BufferGeometry, type Material, type Object3D } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Model } from './adapter';

export interface Appearance {
  mesh: Mesh;
  geometry: BufferGeometry;
  material: Material;
  textures: Texture[];
}

export class Viewer {
  readonly scene = new Scene();
  #renderer: WebGLRenderer | null;
  #canvas: HTMLCanvasElement;
  #model?: Object3D;
  #camera?: PerspectiveCamera | OrthographicCamera;
  #orbit?: OrbitControls;
  #appearance?: Appearance;
  #outline = new Box3Helper(new Box3(), 0x2ad9ed);
  #painting = false;
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
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#appearance = undefined;
    this.#outline.visible = false;
    this.#canvas.hidden = true;
    this.#renderer?.renderLists.dispose();
    this.#renderer?.clear();
  }

  replaceAppearance(appearance?: Appearance) {
    if (this.#appearance) disposeAppearance(this.#appearance);
    this.#appearance = appearance;
  }

  setPainting(active: boolean) {
    this.#painting = active;
    if (this.#orbit) this.#orbit.enabled = !active;
  }

  frame(object = this.#model, orthographic = this.#camera instanceof OrthographicCamera, direction = new Vector3(0.6, 0.45, 1)) {
    if (!object || !this.#renderer) return;
    const box = new Box3().setFromObject(object);
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
    this.#orbit.enabled = !this.#painting;
    this.#orbit.addEventListener('change', () => this.render());
    this.#orbit.update();
    this.render();
  }

  select(object?: Object3D) {
    this.#outline.visible = !!object && shown(object);
    if (this.#outline.visible) this.#outline.box.setFromObject(object!);
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
    if (!this.#appearance) {
      this.#renderer.render(this.scene, this.#camera);
      return;
    }
    const { mesh, geometry, material } = this.#appearance;
    const previous = [mesh.geometry, mesh.material] as const;
    try {
      mesh.geometry = geometry;
      mesh.material = material;
      this.#renderer.render(this.scene, this.#camera);
    } finally {
      [mesh.geometry, mesh.material] = previous;
    }
  }
}

function shown(object: Object3D): boolean {
  for (let value: Object3D | null = object; value; value = value.parent) if (!value.visible) return false;
  return true;
}

export async function prepareAppearance(model: Model): Promise<Appearance | undefined> {
  if (model.format !== 'fbx' || !model.uvAtlas || !model.textureBake) return;
  const mesh = model.scene.getObjectByProperty('isMesh', true);
  const source = mesh instanceof Mesh ? mesh.material : undefined;
  if (!(mesh instanceof Mesh) || !(source instanceof MeshLambertMaterial || source instanceof MeshPhongMaterial)) return;
  const material = source.clone(), geometry = model.uvAtlas.geometry.clone();
  geometry.setAttribute('uv', geometry.getAttribute('uv1'));
  const appearance = { mesh, geometry, material, textures: [] as Texture[] };
  try {
    for (const entry of model.textureBake.maps) {
      if (entry.slot !== 'map' && (entry.slot !== 'normalMap' || !(material instanceof MeshPhongMaterial))) continue;
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
    return appearance;
  } catch (error) {
    disposeAppearance(appearance);
    throw error;
  }
}

export function disposeAppearance(appearance: Appearance) {
  appearance.geometry.dispose();
  appearance.material.dispose();
  for (const texture of appearance.textures) texture.dispose();
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
