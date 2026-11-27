const defaults = {
  save: ['Save project', 'Ctrl+S'], undo: ['Undo', 'Ctrl+Z'], redo: ['Redo', 'Ctrl+Shift+Z'],
  select: ['Object selection', 'Q'], move: ['Move', 'W'], rotate: ['Rotate', 'E'], scale: ['Scale', 'R'],
  vertex: ['Vertex selection', '1'], edge: ['Edge selection', '2'], face: ['Face selection', '3'], island: ['UV island selection', '4'],
  brush: ['2D Brush', 'B'], stamp: ['2D Clone Stamp', 'C'], eyedropper: ['2D Eyedropper', 'I'],
  frame: ['Frame selection', 'F'], apply: ['Apply preview', 'Enter'], cancel: ['Cancel preview', 'Escape'], delete: ['Delete', 'Delete'],
  space: ['Pan 2D or play test', 'Space'],
} as const;
type Action = keyof typeof defaults;
const actions = Object.keys(defaults) as Action[];
const storage = 'assetfixer.shortcuts';
let overrides: Partial<Record<Action, string>> = {};
try {
  const saved = JSON.parse(localStorage.getItem(storage) ?? '{}') as Partial<Record<Action, unknown>>;
  for (const action of actions) if (typeof saved[action] === 'string' && saved[action].length < 95) overrides[action] = saved[action];
} catch { /* The default shortcuts remain available without browser storage. */ }

function shortcutKey(event: KeyboardEvent) {
  if (['Control', 'Shift', 'Meta', 'Alt', 'AltGraph', 'Unidentified', 'Dead'].includes(event.key) || event.isComposing) return;
  const key = event.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return `${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

export function shortcut(event: KeyboardEvent): Action | undefined {
  const key = shortcutKey(event);
  return key && actions.find(action => (overrides[action] ?? defaults[action][1]) === key) || undefined;
}

export function configureShortcuts() {
  const dialog = document.getElementById('shortcuts-dialog') as HTMLDialogElement;
  const container = document.getElementById('shortcut-bindings')!, status = document.getElementById('shortcut-status')!;
  const save = () => {
    try { localStorage.setItem(storage, JSON.stringify(overrides)); }
    catch { status.textContent = 'Bindings will last until the page closes.'; }
  };
  const display = (key: string) => /Mac/i.test(navigator.platform) ? key.replace('Ctrl+', 'Cmd+') : key;
  const render = () => {
    container.replaceChildren(...actions.map(action => {
      const label = document.createElement('label'), field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.value = display(overrides[action] ?? defaults[action][1]);
      field.setAttribute('aria-label', `${defaults[action][0]} shortcut`);
      field.addEventListener('keydown', event => {
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        const key = shortcutKey(event);
        if (!key) return;
        const conflict = actions.find(other => other !== action && key === (overrides[other] ?? defaults[other][1]));
        if (conflict) { status.textContent = `${display(key)} is assigned to ${defaults[conflict][0]}.`; return; }
        overrides[action] = key;
        field.value = display(key);
        status.textContent = `${defaults[action][0]} uses ${display(key)}.`;
        save();
      });
      label.append(defaults[action][0], field);
      return label;
    }));
  };
  document.getElementById('shortcuts-open')!.addEventListener('click', () => { status.textContent = ''; render(); dialog.showModal(); });
  document.getElementById('shortcuts-reset')!.addEventListener('click', () => { overrides = {}; status.textContent = 'Default shortcuts restored.'; save(); render(); });
}
