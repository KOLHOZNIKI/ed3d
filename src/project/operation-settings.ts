export const settingIds = [
  'fbx-texture-files',
  'texture-tool', 'texture-color', 'texture-size', 'texture-opacity', 'texture-hardness', 'texture-shape', 'texture-stamp',
  'texture-alpha', 'texture-alpha-value', 'texture-filter',
  'paint-mode', 'paint-color', 'paint-opacity', 'paint-hardness',
  'uv-size', 'uv-padding', 'uv-allow-rotate', 'uv-equalize', 'uv-selected-only', 'uv-mode-select', 'uv-source', 'uv-filter', 'uv-missing',
  'uv-projection-distance', 'uv-projection-angle', 'uv-projection-offset', 'uv-projection-direction', 'uv-projection-fallback', 'uv-projection-color',
  'repair-method', 'repair-project', 'repair-tolerance', 'repair-density', 'repair-iterations', 'repair-segments', 'repair-span',
  'repair-scope', 'repair-max-edges', 'repair-max-diameter', 'repair-allow-planar', 'repair-allow-fan',
  'extract-kind', 'extract-copy', 'extract-layout', 'extract-size', 'extract-padding', 'extract-fill',
  'extract-pivot', 'extract-rx', 'extract-ry', 'extract-rz', 'extract-scale', 'extract-origin',
] as const;

export type OperationSettings = Readonly<Partial<Record<typeof settingIds[number], string | boolean>>>;

export function readOperationSettings(value: unknown): OperationSettings | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project operation settings.');
  const supported = new Set<string>(settingIds);
  for (const [key, setting] of Object.entries(value)) {
    if (!supported.has(key) || typeof setting !== 'boolean' && (typeof setting !== 'string' || setting.length > 100)) {
      throw new Error('Invalid project operation setting.');
    }
  }
  return value as OperationSettings;
}
