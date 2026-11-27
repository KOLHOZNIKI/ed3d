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

Open the localhost URL printed by Vite. Choose a self-contained GLB and use **Export GLB** to download a new binary. For FBX, open a ZIP, select the binary FBX and its PNG/JPEG maps together, or use **Open folder** to preserve the folder structure. When a map is missing or ambiguous, choose an input map or a local replacement and click **Open with assignments**. **Export FBX ZIP** downloads the reconstructed FBX, external maps, manifest and export reports. Extract the package into Unity's `Assets` folder. The manifest identifies textures that require manual assignment. **Export Original** downloads the original bytes, packaged together when the input consisted of multiple files.

Use **Save Project** to download a self-contained `.assetfixer` file. **Save As** creates a copy with a new project ID. Open the saved file from the same file picker after restarting the app. The project restores its original source bytes and current working state. Undo and Redo begin with the reopened state. After an edit the browser keeps local checkpoints and offers **Restore autosave** at startup. If an edit would exceed the history budget, the browser saves the new revision before releasing old history. A storage failure keeps the current edit history intact. Save a project file to keep a backup outside browser storage.

In a Release or Debug build served on HTTPS or localhost, open **Offline launch** and click **Save application for offline launch**. Return to the same browser profile and URL to launch from the cache without a connection. Use **Asset diagnostics and export report** to review material bindings, run the geometry, UV and weight scan, focus a finding and save a text or JSON report. GLB export keeps its report available through this panel.

Right-drag to orbit, middle-drag to pan, and scroll to zoom. Click a mesh in the viewport or the **Scene** panel, then use **Frame selection** or `F`. Hold Shift to add or remove items. Choose **Rectangle** or **Lasso** in the viewport to select a region. Enable **Select through surfaces** to include occluded geometry. Use **Shortcuts** to reassign commands. Use the layout picker to place the 3D view next to **Texture** or **UV**. Drag the dividers or focus one and press the arrow keys to resize the panels. The browser remembers the layout and shortcuts.

In **Object** mode, select static meshes or groups and enter Move, Rotate or Scale values in the Inspector. Choose world axes or the active object's local axes, then choose the median, active object, or 3D cursor as the pivot. Click **Export selection** to export the selected objects with their hierarchy, materials and applicable skin or animation dependencies.

Use **Display** for textured, unlit, solid, wireframe, wire overlay, checker, normals or bone weights. **Guides and lighting** controls the floor grid, axes, bounds, light exposure and background. **Compare** shows the original import or a captured working revision with the same camera. **Isolate object** scopes the 3D preview to the selected mesh. [Workspace guide and verification](Docs/Workspace_Report.md)

For a single FBX mesh with one UV set, use **Generate UV atlas** to add UV1. **Rebake textures** transfers the maps from the original import. The baked FBX promotes the atlas to the primary UV channel for Unity and retains the original coordinates in the second channel.

Turn on **3D Paint**, choose a Base Color binding and drag on the model. **Surface** measures brush diameter along connected faces in scene units. **Screen projection** reaches visible faces in the selected binding within a viewport-pixel diameter. **Texture pixels** snaps a square brush to the image grid. Right-drag to orbit and scroll to zoom inside Paint mode.

To restrict writes, choose **Selected faces** or **Selected UV islands**, then use **Pick mask regions** to toggle the regions on the model. Turn off region picking before painting. Shared images require confirmation, or you can use **Copy for this binding** in the texture editor. Use **Frozen pose** and **Time** to inspect and paint a specific frame of a skinned mesh. **Create paint atlas** unwraps eligible FBX meshes that have no UVs and gives them a blank Base Color map.

Open **Texture editor** and choose a material map. Use **Edit alpha** on Base Color, or choose the Roughness, Metallic, or AO channel on a supported data map. The 2D view has Brush, Clone Stamp, Eyedropper, Pixel Brush and a rectangular mask. Set the stamp source with `Alt` + click. Use **Resize texture** for an undoable resize with nearest or bilinear sampling. **Focus UVs** frames the current material's sampling region. Use **Export PNG** to download the image at its working dimensions. 2D and 3D edits share Undo and Redo.

Open **Mesh Edit** and choose an object. Click a vertex, edge or face in the viewport, use Shift-click to extend the selection, or enter element IDs. Move, Rotate and Scale support axis handles, numeric values and a pivot. Use **Preview** to inspect an edit, then **Apply** or Enter. Press Esc to cancel. Use the ordered vertex selection for **Create Face**. **Separate** creates another object with the selected faces and their existing material bindings.

Open **Repair** to inspect boundaries on the selected object. Mark intentional openings **Keep Open**. Choose **Planar Fill**, **Fan Fill**, or **Manual Face** for selected boundaries. **Auto Fill** previews a batch with edge, diameter, and planarity limits. Check the wireframe and the reason for each skipped contour before applying. The resulting faces can be selected for mesh editing or 3D Paint.

Use **Smooth Fill** for a non-planar patch with a fixed rim. Set refinement passes and fairing iterations. **Grid Fill** creates quads between four automatically detected or entered corner vertex IDs. Opposite sides need the same segment counts. **Bridge** joins two boundaries or equal-length spans. The default pairing minimizes distance. Use offsets, twist, and segments to adjust the preview. **Edit new UVs** opens the UV Editor with the added faces selected.

Open **UV Editor** to select a material, map, and UV channel. Pick UV vertices, edges, faces, or islands in the grid or on the model. Drag to move the selection, use the transform handle for rotation and scaling, or enter numeric values. Use the wheel to zoom and middle-drag to pan. **Auto Unwrap** and **Pack Islands** write to the UV draft.

To join a shared UV seam, choose **Edge** and **Stitch UV edge**. Click the side to keep fixed, then click **Update draft**. Review the result and apply it with **Change Mapping** or **Preserve Appearance**. The tool joins one shared edge at a time. [UV stitch workflow and results](Docs/UV_Stitch.md)

Choose **Change Mapping** to move UVs while keeping the images unchanged. Choose **Preserve Appearance** to transfer the current painted maps to the draft. You can also select **Original import** when the source corners still match. **Rebake and Apply** commits both the UVs and the new maps together. Use **Coverage** to inspect sampled texels and any repairs filled with neutral data. FBX exports put the baked layout in UV0 and retain the source layout in UV1. GLB exports bind the baked maps to the selected channel.

Choose **Spatial Projection** to transfer maps onto changed geometry. Select the source mesh and snapshot. If either mesh has multiple components, assign each target component one source component using the displayed component IDs. Use maximum distance, normal angle, ray direction, and offset to constrain the transfer. **Coverage** marks hits in teal, unresolved texels in magenta, and explicitly permitted nearest-surface samples in amber.

Open **Extract** to select a whole static mesh, one or more connected components, or arbitrary faces. Use **Isolate selection** to review the result and check the count of newly exposed boundary edges. **Copy** is the default. **Separate Geometry** keeps the existing material bindings. **Make Independent Asset** creates separate maps so later paint edits affect only the new object.

Choose **Keep UVs** to clear unused atlas regions, **Pack existing islands** to use the available tile space, or **Auto Unwrap** to build new charts. Set a pivot and any explicit rotation or scale before creating the asset. Turn on **Export pivot at world zero** to rebase only the standalone export. Use **Export selected asset** for an individual FBX ZIP or GLB and **Export checked assets ZIP** for a batch with a manifest.

Open **Rig & Pose** on a skinned model. Pick a joint in the viewport or hierarchy. In **Working rest**, move the joint or rotate its axes using the handle or numeric offsets. Choose how descendants follow the edit. To mirror the edit, select a partner and a symmetry plane under **Hierarchy and binding**. The app rebinds all affected meshes together. Turn on **Show original skeleton** to compare the rigs.

In **Manual pose**, rotate joints in local or world axes and use **Reset Bone** or **Reset Pose** to return to the working rest. Save named poses in the project and reload them with the quick buttons. To inspect a finger chain, enter consecutive joint IDs and use **Curl chain** or **Preview joint sweep**. Under **Original clips and adaptations**, review each clip and choose whether to adapt or exclude incompatible clips before export. Use **Include manual pose offsets** to apply the current corrections to a separately named adaptation.

Open **Weight Paint** and choose a skinned object. Select an influence to see its heatmap and use **Lock influence** to protect its weight. Set the brush radius, strength, falloff, and face mask, then paint in the working rest, a manual pose, or a frozen clip frame. **Smooth** averages only edge-connected neighbors. Use **Vertex IDs** with **Set exact weight** or **Normalize** for a numeric correction. Each stroke is one Undo step.

Use **Find invalid** to locate problem vertices. Choose a fallback joint for zero sums, and use **Preview conversion** to see weight loss and the resulting deformation before converting rows with extra influences. **Mirror weights** uses the chosen world plane and explicit joint pairs. **Transfer weights** samples an original or captured working mesh using distance, normal, and source-face limits. Both operations report skipped vertices.

Open **Humanoid Tests**, expand **Humanoid mapping**, and use **Suggest roles** to assign joints. Review the confidence and resolve missing or duplicate roles. Under **Calibration and offsets**, align a T/A reference or capture the current manual pose. You can adjust the local motion axes and save arm, leg, and pelvis offsets for the character.

Choose one of the ten diagnostic clips and use play, scrub, frame step, or repeat range. Turn on **Root motion** to preview travel where the clip provides it. Use **Freeze for Weight Paint** to edit at the selected frame. Return to **Humanoid Tests** to replay the same interval. **Save current pose** stores a reusable checkpoint. **Include selected diagnostic in exports** stores a separately named clip recipe from the current settings.

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
| `@comfyorg/fbx-exporter-three` | MIT | Patched binary FBX writer for Unity-compatible exports. |
| `fflate` | MIT | Local ZIP reading and writing. |
| `fast-png` | MIT | Preserve straight RGBA pixels during the alpha bake. |
| `xatlas-wasm` | MIT | Generate and pack UV charts in a browser worker. |
| `patch-package` | MIT | Apply the pinned loader and writer patches during installation. |

The static distribution includes notices for xatlas and its WASM wrapper, iobuffer, the Meshopt decoder and MikkTSpace alongside the directly bundled packages. [xatlas license](https://github.com/jpcy/xatlas/blob/master/LICENSE) · [WASM wrapper license](https://github.com/mode777/xatlas-wasm/blob/main/LICENSE)

## Verification

- [Workspace and rendering verification](Docs/Workspace_Report.md) covers §8 layout, viewing, comparison and keyboard behavior.
- [E12 full acceptance](Docs/E12_Report.md) records the V1 workflows, Unity Generic and Humanoid checks, independent reads and performance measurements.
- [Format and project support](Docs/Formats_and_Projects.md) describes the supported import and export profiles and the `.assetfixer` schema and migrations.
- [E11 humanoid diagnostics verification](Docs/E11_Report.md) covers mapping, calibration, all ten clips, frozen weight painting, and FBX and GLB export.
- [E10 weight editing verification](Docs/E10_Report.md) covers locks, fifth-influence conflicts, frozen-frame smoothing, UV seams, weight transfer, and FBX and GLB exports.
- [E09 rig and manual pose verification](Docs/E09_Report.md) covers shared binding, pose persistence, clip compatibility, and FBX and GLB exports.
- [E08 extended repair and projection verification](Docs/E08_Report.md) covers pinned patches, bridge pairing, projected normals, missing samples, and FBX animation after Smooth Fill.
- [E07 static asset extraction verification](Docs/E07_Report.md) covers component grouping, map ownership, pivot, scale, orientation, and batch export.
- [E06 UV editing and direct bake verification](Docs/E06_Report.md) covers painted appearance, UV corner selection, cancellation, skinned export, and directional normals.
- [E05 Basic Repair verification](Docs/E05_Report.md) covers protected openings, concave and non-planar contours, patch intersections, and skinned FBX repair.
- [E04 Mesh Core verification](Docs/E04_Report.md) covers logical vertex edits, UV and normal seams, ordered face creation, and FBX skinning after a split and separation.
- [E03 3D Paint verification](Docs/E03_Report.md) covers UV seams, visible surface isolation, masks, and painting on a frozen skinned pose.
- [E02 texture editor verification](Docs/E02_Report.md) records color sampling, stamp isolation, pixel zoom, mixed history and FBX/GLB export.
- [E01 project and recovery verification](Docs/E01_Report.md) records the offline reopening, checkpoint and Unity tests.
- [E00 format and risk verification](Docs/E00_Report.md) records backend decisions, fixture provenance, reference exports and adapter checks.
