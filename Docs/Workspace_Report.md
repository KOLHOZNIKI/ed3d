# Desktop workspace and rendering

The workspace addresses the screen organization, panel controls and model inspection in [§8 of the specification](AssetFixer_Technical_Specification_v1.0.md#sec-08).

## Working in the editor

- Use the top bar to open files or a folder, save a project, manage Undo and Redo, or export. The mode bar selects Object, Mesh Edit, Repair, UV, Paint, Extract, Rig, Weight Paint or Humanoid Tests. The inspector shows the active tool, project settings and quick operations.
- Select objects, material bindings and bones from the Scene panel. Selecting a material with a Base Color binding activates the texture editor. Selecting a bone opens Rig & Pose. The bottom bar shows the project, current selection, history, background jobs and warnings.
- Choose a 3D, 2D-only or split workspace in the layout picker. Drag a divider or use its arrow keys when focused. Use **Scene** and **Tools** to collapse either side panel. Layout, widths and panel visibility are stored locally in browser settings. Narrow windows stack the viewport and editors.
- The WebGL2 drawing buffer follows the on-screen canvas size and device pixel ratio. The fixed-aspect editing area keeps predictable picking and brush coordinates across layouts. The viewport offers perspective and orthographic projection, six axis views, and framing for the selection or the scene.
- **Display** offers textured, unlit Base Color, solid, wireframe, wireframe overlay, UV checker, normals and weight heatmap. Textured rendering uses the imported material profile, including PBR materials in GLB. **Guides and lighting** provides a floor grid, axes, bounds, exposure and background color.
- **Compare** can show the original import or one captured working revision. Side-by-side uses the same camera for both halves. Moving the camera in either half updates both views. The viewport enters inspection mode while comparing. The local snapshot is held for the current project session.
- Use **Isolate object** to inspect a mesh. Mesh Edit includes Select All, Clear, Invert, Select Boundary, Select by Material and Select Connected. Ctrl+S or Cmd+S saves a project. Right-drag orbits, middle-drag pans, and holding Space pans when a 2D editor has focus.

Workspace settings, display styles, helpers, comparison and isolation are preview data. An exported FBX or GLB uses the working document and the selected export scope.

## Shader previews

Use **Display** to switch between the regular material view, **PBR Studio**, **Cartoon**, **Sketch**, and **Hologram**. PBR Studio uses an offline studio lighting environment and reads the GLB material maps or the compatible Base Color, Normal, Roughness and Metallic maps supplied with an FBX. Cartoon keeps the base colors under banded shading. Sketch uses ink hatching, and Hologram highlights the silhouette with cyan scan lines. The presets apply to the viewport, including skinned poses and side-by-side comparison. The project's materials and export use the working asset data.

The browser check rendered 11 distinct static views in Chrome and Edge. Swapping the Tripo character's Roughness and Metallic images changed the PBR preview. A manual joint rotation changed the Cartoon preview of the shared-skeleton fixture. The Tripo plate export retained its original texture bytes while Hologram was active.

## Verification

The desktop browser check used Chrome 158.0.8127.37 and Edge 158.0.4370.45 at 1920 × 1080. The 3D drawing buffer measured 1160 × 870 at DPR 1 in the default layout. The Tripo plate exercised all seven static display modes, lighting and guide settings, isolation and paired comparison. The shared-skeleton fixture exercised the bone tree and weight heatmap. A compact 920-pixel-wide viewport had no horizontal page overflow.

The browser test also verified keyboard resizing, panel collapse, UV-only layout restoration in a fresh tab, the Save shortcut and mesh selection commands. The E01–E12 and UV Stitch browser regressions passed on the updated Release build. They cover actual edits, loss of WebGL context, exported maps and reopening projects. Production and Debug use the same workspace controls.

The browser exported the plate while comparing a snapshot in Wireframe mode. It matched the original linked texture bytes. An independent ufbx read found 4,577 matching control points, 5,134 polygons, exact corner UVs and zero base position error. Unity 2022.3.62f2 and 6000.3.9f1 accepted the plate and the animated E11 fixture with all 11 exported clips.

The [E12 benchmark workload](E12_Report.md#performance-and-memory) on the RTX 3070 measured a 16.8 ms p95 frame interval at 1920 × 1080. The direct bakes took 3.55 s for 2K and 7.12 s for 4K. The hardware run wrote `test-results/e12/benchmark-workspace.json`.

## V1 selection and transforms

The V1 follow-up adds rectangle and lasso picking, explicit through-surface selection, shared object transforms with median, active-object and cursor pivots, and editable keyboard bindings. See the [V1 verification](V1_Report.md) for current coverage and constraints.

## Reproduce

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/workspace-browser.mjs
node tools/workspace-browser.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' edge
node tools/e03-browser.mjs
node tools/e06-browser.mjs
node tools/e12-browser.mjs
node tools/e12-benchmark.mjs 'C:/Program Files/Google/Chrome/Application/chrome.exe' workspace
```

The browser harness uses the pinned [Playwright setup](E00_FBX_Round_Trip.md#reproduce-on-windows), the local Tripo plate, and the repository shared-skeleton and boundary fixtures. The screenshots and JSON reports are under `test-results/workspace/`.
