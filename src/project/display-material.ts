import { MeshPhongMaterial, MeshStandardMaterial, type Material } from 'three';

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
  hologram: /* glsl */ `
    float line = pow(0.5 + 0.5 * cos(gl_FragCoord.y * 1.26), 4.0);
    float rim = pow(1.0 - facing, 2.1);
    outgoingLight = vec3(0.016, 0.13, 0.20) + (0.27 * line + 0.88 * rim) * vec3(0.12, 0.80, 1.0);
  `,
};

export type ShaderLook = keyof typeof shaderLooks;

function copySurface(material: MeshPhongMaterial | MeshStandardMaterial, source: Material) {
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
