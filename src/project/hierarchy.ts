import { Bone, Mesh } from 'three';
import type { ModelAdapter } from './adapter';
import type { WorkingState } from './state';
import type { TextureCatalog } from '../texture/bindings';

type SceneContext = { adapter: ModelAdapter; state: WorkingState; textures: TextureCatalog };
const byId = (id: string) => document.getElementById(id)!;

export class SceneHierarchy {
  #list = byId('scene-hierarchy');
  #materials = byId('scene-material-list');
  #bones = byId('scene-bone-list');
  #context?: SceneContext;
  #selected = '';
  #joint = '';

  constructor(readonly select: (id: string, toggle: boolean) => void, readonly selectMap: (id: string) => void, readonly selectBone: (id: string) => void) {}

  configure(context: SceneContext | undefined, selected: string, all: ReadonlySet<string>, joint: string, locked: boolean) {
    this.#list.inert = this.#materials.inert = this.#bones.inert = locked;
    const changed = context?.adapter !== this.#context?.adapter || context?.state !== this.#context?.state;
    if (changed) {
      this.#context = context;
      this.#objects(context);
      this.#skeleton(context);
    }
    if (changed || this.#selected !== selected) {
      this.#selected = selected;
      this.#select(this.#list, selected);
      this.#materialList(context, selected);
    }
    for (const button of this.#list.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(all.has(button.dataset.id!)));
    if (changed || this.#joint !== joint) {
      this.#joint = joint;
      this.#select(this.#bones, joint);
    }
  }

  #select(list: HTMLElement, id: string) {
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-current', String(button.dataset.id === id));
    }
  }

  #objects(context?: SceneContext) {
    const rows: HTMLLIElement[] = [];
    const depth = new Map<string, number>();
    for (const entry of context?.adapter.viewEntries ?? []) {
      const node = context!.adapter.objects.get(entry.id);
      if (node instanceof Bone) continue;
      const state = context!.state.objects[entry.id] ?? entry;
      const level = (depth.get(entry.parent ?? '') ?? -1) + 1;
      depth.set(entry.id, level);
      let hasMesh = entry.mesh;
      if (!hasMesh) node?.traverse(child => { hasMesh ||= child instanceof Mesh; });
      rows.push(this.#row(state.name, level, hasMesh ? event => this.select(entry.id, event.shiftKey) : undefined, entry.id, !state.visible));
    }
    this.#list.replaceChildren(...rows);
    this.#list.hidden = !rows.length;
  }

  #materialList(context: SceneContext | undefined, selected: string) {
    const meshId = selected || context?.adapter.viewEntries.find(entry => entry.mesh)?.id;
    const node = meshId && context?.adapter.objects.get(meshId);
    const rows: HTMLLIElement[] = [];
    if (node instanceof Mesh) {
      const targets = context!.textures.targets(context!.state).filter(target => target.binding.object === meshId);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const [slot, material] of materials.entries()) {
        const target = targets.find(item => item.binding.slot === slot);
        const row = this.#row(material.name || `Material ${slot + 1}`, 0, target && (() => this.selectMap(target.binding.id)));
        if (target) {
          const description = document.createElement('small');
          description.textContent = `Base Color · UV${target.transfer?.channel ?? target.binding.texture.channel}`;
          row.firstElementChild!.append(description);
        }
        rows.push(row);
      }
    }
    this.#materials.replaceChildren(...rows);
    byId('scene-materials').hidden = !rows.length;
  }

  #skeleton(context?: SceneContext) {
    const joints = context?.state.rig?.joints ?? context?.adapter.rig.original.joints ?? [];
    const byParent = new Map<string | null, typeof joints[number][]>();
    const jointIds = new Set(joints.map(joint => joint.id));
    for (const joint of joints) {
      const parent = joint.parent && jointIds.has(joint.parent) ? joint.parent : null;
      const children = byParent.get(parent) ?? [];
      children.push(joint);
      byParent.set(parent, children);
    }
    const rows: HTMLLIElement[] = [];
    const visit = (parent: string | null, level: number) => {
      for (const joint of byParent.get(parent) ?? []) {
        rows.push(this.#row(joint.name, level, () => this.selectBone(joint.id), joint.id));
        visit(joint.id, level + 1);
      }
    };
    visit(null, 0);
    this.#bones.replaceChildren(...rows);
    byId('scene-bones').hidden = !rows.length;
  }

  #row(name: string, depth: number, action?: (event: MouseEvent) => void, id?: string, hidden = false) {
    const row = document.createElement('li');
    row.style.setProperty('--depth', String(depth));
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = hidden ? `${name} (hidden)` : name;
      if (id) button.dataset.id = id;
      button.toggleAttribute('data-hidden', hidden);
      button.addEventListener('click', action);
      row.append(button);
    } else {
      const group = document.createElement('span');
      group.className = 'scene-group';
      group.textContent = name;
      row.append(group);
    }
    return row;
  }
}
