# AssetFixer

AssetFixer is a local browser-based editor for refining generated 3D assets before importing them into Unity. The E00 prototype opens and exports FBX packages and self-contained GLB files in the browser.

## Local development

Use an LTS release of Node.js 22.12 or later with npm and a desktop browser with WebGL2. Chrome and Edge on Windows are the primary browser targets.

| Windows command | Purpose |
| --- | --- |
| [`build-release.cmd`](build-release.cmd) | Type-check and build the minified Release bundle in `dist/`. |
| [`build-debug.cmd`](build-debug.cmd) | Type-check and build in `dist-debug/` with readable JavaScript and source maps. |
| [`run.cmd`](run.cmd) | Start the Release build locally and open it in the default browser. |
| `run.cmd debug` | Start the Debug build locally and open it in the default browser. |

The launcher builds the selected version if its output is missing. Rebuild after changing source files to refresh an existing output. The scripts install locked dependencies on a fresh checkout. Run `npm ci` again after changes to the lockfile or dependency patches. Press **Ctrl+C** in the launch window to stop the server.

For a development server that reloads on source changes, use the npm commands below.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Choose a self-contained GLB and use **Export GLB** to download a new binary. For FBX, choose a Tripo ZIP or select a binary FBX and its PNG or JPEG textures together. **Export FBX ZIP** downloads the reconstructed FBX, external maps, and `manifest.json`. Extract the package into Unity's `Assets` folder to import it. The manifest identifies textures that require manual assignment.

For a single FBX mesh with one UV set, use **Generate UV atlas** to add UV1. **Rebake textures** transfers the maps from the original import. The baked FBX promotes the atlas to the primary UV channel for Unity and retains the original coordinates in the second channel.

After rebaking a static mesh with one base color map, turn on **3D brush (visible projection)** and drag on the model. **Undo stroke** restores the preceding texture. **Export FBX ZIP** packages the painted map.

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
| `fast-png` | MIT | Preserve straight RGBA pixels during the alpha bake. |
| `xatlas-wasm` | MIT | Generate and pack UV charts in a browser worker. |
| `patch-package` | MIT | Apply the pinned loader and writer patches during installation. |

## E00 verification

The [E00 verification report](Docs/E00_Report.md) consolidates the results, backend decisions, fixture provenance, and E01 readiness checklist. It links the individual test recipes and reference exports.
