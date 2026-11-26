# AssetFixer

AssetFixer is a local browser-based editor for refining generated 3D assets before importing them into Unity. The E00 prototype opens and exports FBX packages in the browser.

## Local development

Use an LTS release of Node.js 22.12 or later with npm and a desktop browser with WebGL2. Chrome and Edge on Windows are the primary browser targets.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Choose a Tripo ZIP or select a binary FBX and its PNG or JPEG textures together. Use **Export FBX ZIP** to download the reconstructed FBX, external maps, and `manifest.json`. Extract the package into Unity's `Assets` folder to import it. The manifest identifies textures that require manual assignment.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the application with strict TypeScript settings. |
| `npm run build` | Check types and generate the static build in `dist/`. |
| `npm run preview` | Serve the production build locally after building it. |

Install dependencies with `npm ci` so the build uses the versions recorded in `package-lock.json`.

## Dependencies

| Package | License | Purpose |
| --- | --- | --- |
| `three` | MIT | WebGL2 viewport and rendering. |
| `@types/three` | MIT | Type definitions matching the Three.js release. |
| `typescript` | Apache-2.0 | Strict type checking. |
| `vite` | MIT | Local development server and static bundling. |
| `@comfyorg/fbx-exporter-three` | MIT | Candidate binary FBX writer for E00. |
| `fflate` | MIT | Local ZIP reading and writing. |

## E00 verification

The [FBX and ZIP report](Docs/E00_FBX_Round_Trip.md) records the Unity and ufbx results, known topology loss, and commands to repeat the checks. The [technical specification](Docs/AssetFixer_Technical_Specification_v1.0.md#sec-21) covers the rest of E00.
