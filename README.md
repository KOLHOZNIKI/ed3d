# AssetFixer

AssetFixer is a local browser-based editor for refining generated 3D assets before importing them into Unity. The E00 prototype opens and exports FBX packages and self-contained GLB files in the browser.

## Local development

Use an LTS release of Node.js 22.12 or later with npm and a desktop browser with WebGL2. Chrome and Edge on Windows are the primary browser targets.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Choose a self-contained GLB and use **Export GLB** to download a new binary. For FBX, choose a Tripo ZIP or select a binary FBX and its PNG or JPEG textures together. **Export FBX ZIP** downloads the reconstructed FBX, external maps, and `manifest.json`. Extract the package into Unity's `Assets` folder to import it. The manifest identifies textures that require manual assignment.

For a single FBX mesh with one UV set, use **Generate UV atlas** to add UV1. **Rebake textures** transfers the maps from the original import. The baked FBX promotes the atlas to the primary UV channel for Unity and retains the original coordinates in the second channel.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the application with strict TypeScript settings. |
| `npm run build` | Check types and generate the static build in `dist/`. |
| `npm run preview` | Serve the production build locally after building it. |

`npm ci` uses the versions recorded in `package-lock.json` and applies the format adapter patches in `patches/`.

## Dependencies

| Package | License | Purpose |
| --- | --- | --- |
| `three` | MIT | WebGL2 viewport and rendering. |
| `@types/three` | MIT | Type definitions matching the Three.js release. |
| `typescript` | Apache-2.0 | Strict type checking. |
| `vite` | MIT | Local development server and static bundling. |
| `@comfyorg/fbx-exporter-three` | MIT | Candidate binary FBX writer for E00. |
| `fflate` | MIT | Local ZIP reading and writing. |
| `xatlas-wasm` | MIT | Generate and pack UV charts in a browser worker. |
| `patch-package` | MIT | Apply the pinned loader and writer patches during installation. |

## E00 verification

The [FBX and ZIP report](Docs/E00_FBX_Round_Trip.md) records the Unity and ufbx results. The [GLB report](Docs/E00_GLB_Round_Trip.md) covers the Tripo character, exact texture and weight checks, and Khronos validation. The [xatlas report](Docs/E00_XAtlas.md) covers UV1 generation and vertex attributes at seams. The [texture rebake report](Docs/E00_Texture_Rebake.md) covers the texture transfer and Unity render comparisons. The [technical specification](Docs/AssetFixer_Technical_Specification_v1.0.md#sec-21) covers the rest of E00.
