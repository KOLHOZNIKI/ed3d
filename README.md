# AssetFixer

AssetFixer is a local browser-based editor for refining generated 3D assets before importing them into Unity. It opens FBX packages, self-contained GLB files and `.assetfixer` projects in the browser.

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

Use **Save Project** to download a self-contained `.assetfixer` file. **Save As** creates a copy with a new project ID. Open the saved file from the same file picker after restarting the app. The project restores its original source bytes and current working state. Undo and Redo begin with the reopened state. After an edit the browser keeps local checkpoints and offers **Restore autosave** at startup. Save a project file to keep a backup outside browser storage.

Drag the viewport to orbit, use the right mouse button to pan, and scroll to zoom. Click a mesh or choose one in **Objects**, then use **Frame selection** or `F`. The viewport also offers orthographic projection and axis views. Project labels and viewport visibility are saved as project state. Format export uses the source object names and complete scene.

For a single FBX mesh with one UV set, use **Generate UV atlas** to add UV1. **Rebake textures** transfers the maps from the original import. The baked FBX promotes the atlas to the primary UV channel for Unity and retains the original coordinates in the second channel.

Turn on **3D Paint**, choose a Base Color binding and drag on the model. **Surface** measures brush diameter along connected faces in scene units. **Screen projection** reaches visible faces in the selected binding within a viewport-pixel diameter. **Texture pixels** snaps a square brush to the image grid. Right-drag to orbit and scroll to zoom inside Paint mode.

To restrict writes, choose **Selected faces** or **Selected UV islands**, then use **Pick mask regions** to toggle the regions on the model. Turn off region picking before painting. Shared images require confirmation, or you can use **Copy for this binding** in the texture editor. Use **Frozen pose** and **Time** to inspect and paint a specific frame of a skinned mesh. **Create paint atlas** unwraps eligible FBX meshes that have no UVs and gives them a blank Base Color map.

Open **Texture editor** to edit the selected object's Base Color material. The 2D view has Brush, Clone Stamp, Eyedropper, Pixel Brush and a rectangular mask. Set the stamp source with `Alt` + click. Use the mouse wheel to zoom at the cursor and the middle button to pan. **Focus UVs** frames the current material's sampling region. Use **Export PNG** to download the image at its working dimensions. 2D and 3D edits share Undo and Redo.

Open **Mesh Edit** and choose an object. Click a vertex, edge or face in the viewport, use Shift-click to extend the selection, or enter element IDs. Move, Rotate and Scale support axis handles, numeric values and a pivot. Use **Preview** to inspect an edit, then **Apply** or Enter. Press Esc to cancel. Use the ordered vertex selection for **Create Face**. **Separate** creates another object with the selected faces and their existing material bindings.

Open **Repair** to inspect boundaries on the selected object. Mark intentional openings **Keep Open**. Choose **Planar Fill**, **Fan Fill**, or **Manual Face** for selected boundaries. **Auto Fill** previews a batch with edge, diameter, and planarity limits. Check the wireframe and the reason for each skipped contour before applying. The resulting faces can be selected for mesh editing or 3D Paint.

Use **Smooth Fill** for a non-planar patch with a fixed rim. Set refinement passes and fairing iterations. **Grid Fill** creates quads between four automatically detected or entered corner vertex IDs. Opposite sides need the same segment counts. **Bridge** joins two boundaries or equal-length spans. The default pairing minimizes distance. Use offsets, twist, and segments to adjust the preview. **Edit new UVs** opens the UV Editor with the added faces selected.

Open **UV Editor** to select a material, map, and UV channel. Pick UV vertices, edges, faces, or islands in the grid or on the model. Drag to move the selection, use the transform handle for rotation and scaling, or enter numeric values. Use the wheel to zoom and middle-drag to pan. **Auto Unwrap** and **Pack Islands** write to the UV draft.

Choose **Change Mapping** to move UVs while keeping the images unchanged. Choose **Preserve Appearance** to transfer the current painted maps to the draft. You can also select **Original import** when the source corners still match. **Rebake and Apply** commits both the UVs and the new maps together. Use **Coverage** to inspect sampled texels and any repairs filled with neutral data. FBX exports put the baked layout in UV0 and retain the source layout in UV1. GLB exports bind the baked maps to the selected channel.

Choose **Spatial Projection** to transfer maps onto changed geometry. Select the source mesh and snapshot. If either mesh has multiple components, assign each target component one source component using the displayed component IDs. Use maximum distance, normal angle, ray direction, and offset to constrain the transfer. **Coverage** marks hits in teal, unresolved texels in magenta, and explicitly permitted nearest-surface samples in amber.

Open **Extract** to select a whole static mesh, one or more connected components, or arbitrary faces. Use **Isolate selection** to review the result and check the count of newly exposed boundary edges. **Copy** is the default. **Separate Geometry** keeps the existing material bindings. **Make Independent Asset** creates separate maps so later paint edits affect only the new object.

Choose **Keep UVs** to clear unused atlas regions, **Pack existing islands** to use the available tile space, or **Auto Unwrap** to build new charts. Set a pivot and any explicit rotation or scale before creating the asset. Turn on **Export pivot at world zero** to rebase only the standalone export. Use **Export selected asset** for an individual FBX ZIP or GLB and **Export checked assets ZIP** for a batch with a manifest.

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

## Verification

- [E08 extended repair and projection verification](Docs/E08_Report.md) covers pinned patches, bridge pairing, projected normals, missing samples, and FBX animation after Smooth Fill.
- [E07 static asset extraction verification](Docs/E07_Report.md) covers component grouping, map ownership, pivot, scale, orientation, and batch export.
- [E06 UV editing and direct bake verification](Docs/E06_Report.md) covers painted appearance, UV corner selection, cancellation, skinned export, and directional normals.
- [E05 Basic Repair verification](Docs/E05_Report.md) covers protected openings, concave and non-planar contours, patch intersections, and skinned FBX repair.
- [E04 Mesh Core verification](Docs/E04_Report.md) covers logical vertex edits, UV and normal seams, ordered face creation, and FBX skinning after a split and separation.
- [E03 3D Paint verification](Docs/E03_Report.md) covers UV seams, visible surface isolation, masks, and painting on a frozen skinned pose.
- [E02 texture editor verification](Docs/E02_Report.md) records color sampling, stamp isolation, pixel zoom, mixed history and FBX/GLB export.
- [E01 project and recovery verification](Docs/E01_Report.md) records the offline reopening, checkpoint and Unity tests.
- [E00 format and risk verification](Docs/E00_Report.md) records backend decisions, fixture provenance, reference exports and adapter checks.
