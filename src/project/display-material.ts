import { Color, DataTexture, LinearFilter, MeshMatcapMaterial, MeshPhongMaterial, MeshStandardMaterial, SRGBColorSpace, Vector3,
  type Material, type Texture } from 'three';

const shaderLooks = {
  cartoon: /* glsl */ `
    float lit = dot(normal, normalize(vec3(-0.45, 0.62, 0.68)));
    float tone = 0.42 + 0.30 * smoothstep(0.16, 0.20, lit) + 0.34 * smoothstep(0.62, 0.66, lit);
    float outline = smoothstep(0.04, 0.20, facing);
    outgoingLight = mix(vec3(0.021, 0.028, 0.044), diffuseColor.rgb * tone, outline);
  `,
  sketch: /* glsl */ `
    float shade = 1.0 - max(0.0, dot(normal, normalize(vec3(-0.46, 0.57, 0.72))));
    float strokes = abs(fract((gl_FragCoord.x + 1.5 * gl_FragCoord.y) / 8.0) - 0.5);
    float crossStrokes = abs(fract((gl_FragCoord.x - gl_FragCoord.y) / 9.0) - 0.5);
    float ink = smoothstep(0.40, 0.70, shade) * (1.0 - smoothstep(0.04, 0.22, strokes));
    ink = max(ink, smoothstep(0.68, 0.96, shade) * (1.0 - smoothstep(0.02, 0.14, crossStrokes)));
    ink = max(ink, 1.0 - smoothstep(0.05, 0.24, facing));
    outgoingLight = mix(vec3(0.79, 0.76, 0.65) * (1.0 - 0.20 * shade), vec3(0.022, 0.024, 0.032), ink);
  `,
};

export type ShaderLook = keyof typeof shaderLooks;

const matcapPresets = {
  'matcap-clay': { color: 0xe6a18a, ambient: .23, key: .85, fill: .19, specular: .095, gloss: 14, rim: .045 },
  'matcap-graphite': { color: 0x7d96ad, ambient: .24, key: .75, fill: .32, specular: .16, gloss: 25, rim: .11 },
  'matcap-metal': { color: 0xa5b8ce, ambient: .19, key: .49, fill: .27, specular: .72, gloss: 52, rim: .24 },
};

export type MatcapLook = keyof typeof matcapPresets;
export const isMatcapLook = (mode: string): mode is MatcapLook => Object.hasOwn(matcapPresets, mode);

export function matcapTexture(look: MatcapLook) {
  const { color, ambient, key, fill, specular, gloss, rim } = matcapPresets[look];
  const size = 128, pixels = new Uint8Array(size * size * 4);
  const base = new Color(color), value = new Color(), rgb = { r: 0, g: 0, b: 0 };
  const normal = new Vector3(), keyLight = new Vector3(-.62, .74, .48).normalize(), fillLight = new Vector3(.76, -.34, .33).normalize();
  const view = new Vector3(0, 0, 1), keyHalf = keyLight.clone().add(view).normalize(), fillHalf = fillLight.clone().add(view).normalize();
  const byte = (component: number) => Math.round(255 * Math.min(1, component));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + .5) / size * 2 - 1, ny = (y + .5) / size * 2 - 1;
    // Extend the rim outside the sphere so bilinear filtering can sample the whole disk.
    const z = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    normal.set(nx, ny, z).normalize();
    const light = ambient + key * Math.max(0, normal.dot(keyLight)) + fill * Math.max(0, normal.dot(fillLight));
    const highlights = specular * (Math.max(0, normal.dot(keyHalf)) ** gloss + .28 * Math.max(0, normal.dot(fillHalf)) ** (gloss * .6));
    const edge = rim * (1 - z) ** 3 * Math.max(0, normal.dot(fillLight));
    value.setRGB(base.r * light + .95 * highlights + .62 * edge, base.g * light + highlights + .8 * edge, base.b * light + highlights + edge);
    value.getRGB(rgb, SRGBColorSpace);
    const offset = (y * size + x) * 4;
    pixels[offset] = byte(rgb.r);
    pixels[offset + 1] = byte(rgb.g);
    pixels[offset + 2] = byte(rgb.b);
    pixels[offset + 3] = 255;
  }
  const texture = new DataTexture(pixels, size, size);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function copySurface(material: MeshPhongMaterial | MeshStandardMaterial | MeshMatcapMaterial, source: Material) {
  const surface = source as Material & Partial<Pick<MeshPhongMaterial, 'map' | 'color' | 'alphaMap'>>;
  if (surface.color) material.color.copy(surface.color);
  material.map = surface.map ?? null;
  material.alphaMap = surface.alphaMap ?? null;
  material.alphaTest = source.alphaTest;
  material.alphaHash = source.alphaHash;
  material.transparent = source.transparent;
  material.opacity = source.opacity;
  material.depthWrite = source.depthWrite;
  material.side = source.side;
  material.vertexColors = source.vertexColors;
}

export function matcapMaterial(source: Material, matcap: Texture) {
  const material = new MeshMatcapMaterial({ matcap, toneMapped: false });
  copySurface(material, source);
  material.color.set(0xffffff);
  material.alphaToCoverage = source.alphaToCoverage;
  if (!source.transparent && source.alphaTest === 0 && !source.alphaHash) material.map = null;
  material.onBeforeCompile = shader => {
    // Use Base Color and vertex colors only for alpha, so their RGB values never tint the capture.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `
        #ifdef USE_MAP
          diffuseColor.a *= texture2D(map, vMapUv).a;
        #endif
      `)
      .replace('#include <color_fragment>', /* glsl */ `
        #ifdef USE_COLOR_ALPHA
          diffuseColor.a *= vColor.a;
        #endif
      `)
      .replace('vec3 viewDir = normalize( vViewPosition );', 'vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);');
  };
  return material;
}

export function shaderLook(source: Material, look: ShaderLook) {
  const material = new MeshPhongMaterial({ toneMapped: false });
  copySurface(material, source);
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', /* glsl */ `
      float facing = clamp(abs(dot(normal, isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition))), 0.0, 1.0);
      ${shaderLooks[look]}
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => look;
  return material;
}

export function pbrMaterial(source: Material) {
  if (source instanceof MeshStandardMaterial) return source.clone();
  const material = new MeshStandardMaterial({ roughness: .68 });
  copySurface(material, source);
  const surface = source as Material & Partial<Pick<MeshPhongMaterial, 'aoMap' | 'aoMapIntensity' | 'emissive' | 'emissiveMap' |
    'emissiveIntensity' | 'normalMap' | 'normalMapType' | 'normalScale' | 'bumpMap' | 'bumpScale' | 'flatShading'>>;
  material.aoMap = surface.aoMap ?? null;
  material.aoMapIntensity = surface.aoMapIntensity ?? 1;
  if (surface.emissive) material.emissive.copy(surface.emissive);
  material.emissiveMap = surface.emissiveMap ?? null;
  material.emissiveIntensity = surface.emissiveIntensity ?? 1;
  material.normalMap = surface.normalMap ?? null;
  if (surface.normalMapType !== undefined) material.normalMapType = surface.normalMapType;
  if (surface.normalScale) material.normalScale.copy(surface.normalScale);
  material.bumpMap = surface.bumpMap ?? null;
  if (surface.bumpScale !== undefined) material.bumpScale = surface.bumpScale;
  material.flatShading = surface.flatShading ?? false;
  return material;
}
