const layouts = ['model', 'texture', 'uv', 'texture-only', 'uv-only'] as const;
export type LayoutChoice = typeof layouts[number];
type EditorKind = 'texture' | 'uv';
type Panel = 'scene' | 'tools';
type Preferences = { layout: LayoutChoice; scene?: number; tools?: number; editor?: number; sceneCollapsed?: boolean; toolsCollapsed?: boolean };
const key = 'assetfixer.workspace';
const byId = <T extends HTMLElement = HTMLElement>(name: string) => document.getElementById(name)! as T;
const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function preferences(): Preferences {
  try {
    const input: Partial<Preferences> | null = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (input && input.layout && layouts.includes(input.layout)) return input as Preferences;
  } catch { /* The workspace also works when browser storage is unavailable. */ }
  return { layout: 'model' };
}

export class WorkspaceLayout {
  #root = byId('workspace');
  #choice = byId<HTMLSelectElement>('workspace-layout');
  #editor = byId('workspace-editor');
  #prefs = preferences();
  #twoDimensional = false;
  #first = true;

  constructor(choose: (layout: LayoutChoice) => void) {
    this.#choice.addEventListener('change', () => choose(this.#choice.value as LayoutChoice));
    for (const panel of ['scene', 'tools'] as const) {
      this.#collapse(panel, this.#prefs[`${panel}Collapsed`] === true);
      byId(`workspace-${panel}-toggle`).addEventListener('click', () => {
        this.#collapse(panel, !this.#prefs[`${panel}Collapsed`]);
        this.#save();
      });
    }
    this.#divider('scene', 240, 170, 370, 1);
    this.#divider('tools', 292, 225, 480, -1);
    this.#divider('editor', 48, 30, 68, -1);
  }

  initialLayout() {
    if (!this.#first) return 'model';
    this.#first = false;
    return this.#prefs.layout;
  }

  setEditorOnly(only: boolean) { this.#twoDimensional = only; }

  sync(project: boolean, viewport: boolean, locked: boolean, editor: EditorKind | undefined, texture: boolean) {
    const layout: LayoutChoice = editor ? this.#twoDimensional ? `${editor}-only` : editor : 'model';
    if (!editor) this.#twoDimensional = false;
    this.#root.dataset.layout = layout;
    this.#choice.value = layout;
    this.#choice.disabled = !project || locked;
    for (const option of Array.from(this.#choice.options)) {
      option.disabled = option.value.startsWith('texture') ? !texture : option.value.startsWith('uv') && !viewport;
    }
    this.#editor.hidden = !editor;
    byId('viewport-panel').hidden = !!editor && this.#twoDimensional;
    byId('workspace-editor-resize').hidden = !editor || this.#twoDimensional;
    byId('model-view').hidden = !project || !viewport;
    byId('workspace-empty').hidden = project && viewport;
    byId('workspace-empty-title').textContent = project ? '3D preview unavailable' : 'Open a 3D asset';
    byId('workspace-empty-copy').textContent = project ? 'The local project is available for saving and export.' : 'Drop an FBX ZIP, GLB, or AssetFixer project here.';
    byId('workspace-open').hidden = project;
    byId('workspace-open').toggleAttribute('disabled', locked);
    if (project && this.#prefs.layout !== layout) {
      this.#prefs.layout = layout;
      this.#save();
    }
  }

  #collapse(panel: Panel, value: boolean) {
    this.#prefs[`${panel}Collapsed`] = value;
    this.#root.toggleAttribute(`data-${panel}-collapsed`, value);
    byId(`${panel}-panel`).hidden = value;
    byId(`workspace-${panel}-resize`).hidden = value;
    byId(`workspace-${panel}-toggle`).setAttribute('aria-pressed', String(!value));
  }

  #divider(panel: Panel | 'editor', fallback: number, min: number, max: number, sign: 1 | -1) {
    const handle = byId(`workspace-${panel}-resize`);
    const proportion = panel === 'editor';
    const set = (value: number) => {
      const size = bounded(Math.round(value), min, max);
      this.#prefs[panel] = size;
      this.#root.style.setProperty(`--${panel}-width`, `${size}${proportion ? '%' : 'px'}`);
      handle.setAttribute('aria-valuenow', String(size));
      handle.setAttribute('aria-valuetext', `${size}${proportion ? '%' : ' pixels'}`);
    };
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    set(typeof this.#prefs[panel] === 'number' && Number.isFinite(this.#prefs[panel]) ? this.#prefs[panel]! : fallback);
    let start: { pointer: number; x: number; width: number; scale: number } | undefined;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const width = this.#editor.parentElement!.clientWidth;
      start = { pointer: event.pointerId, x: event.clientX, width: this.#prefs[panel]!, scale: proportion ? 100 / Math.max(width, 1) : 1 };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (start?.pointer === event.pointerId) set(start.width + (event.clientX - start.x) * start.scale * sign);
    });
    handle.addEventListener('lostpointercapture', () => {
      if (!start) return;
      start = undefined;
      this.#save();
    });
    handle.addEventListener('keydown', event => {
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      set(this.#prefs[panel]! + sign * direction * (proportion ? 3 : 16));
      this.#save();
    });
  }

  #save() {
    try { localStorage.setItem(key, JSON.stringify(this.#prefs)); } catch { /* Storage is optional. */ }
  }
}
