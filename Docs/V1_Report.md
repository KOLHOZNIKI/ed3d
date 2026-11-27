# V1 closure verification

The follow-up covers the desktop interaction and data-handling items identified after E12. The supported interchange profiles and earlier stage results are in the [format matrix](Formats_and_Projects.md) and [E12 report](E12_Report.md).

The V1 browser checks ran on Windows in Chrome and Edge with WebGL2, including a Chrome run against the Debug build. The E01–E12, Workspace and UV Stitch regressions ran against Release. Release and Debug both passed strict TypeScript checking.

| Requirement | Implementation and verification |
| --- | --- |
| §12.1, §12.7 | The 2D editor exposes Roughness, Metallic and AO values on supported maps, plus the existing Base Color Alpha control. The browser test painted independent G and B values in a packed GLB map and R in AO, checked untouched channels in the embedded PNGs, and reopened the working project. Nearest and bilinear resize are explicit undoable commands. |
| §7.4 | Selection export retains ancestor transforms, skin joints and applicable clips. The GLB fixture excluded the unselected mesh and its unique image. The FBX body export excluded the second skinned mesh and kept the shared three-joint chain and one-second `SharedTorsoBend` clip. |
| HIST-06 | A 1 MiB history budget forced trimming after replacing a 1024 × 1024 map with a 16 × 12 map. The latest IndexedDB archive contained the committed revision immediately. An injected storage quota failure preserved the current revision, texture and Undo depth. |
| §20.6 | FBX and GLB inputs with oversized image headers were refused before texture decoding. Both refusals preserved the project that was already open. The 8192 × 8192 Tripo plate imported under the linked image limit. |
| VIEW-08, §8.4 | A visible-only rectangle selected the front and side meshes. A through-surface lasso also selected the fully occluded mesh. The test checked multiple-object isolation, mesh face selection, and UV island lasso selection. |
| VIEW-09, §8.5 | The browser applied move, rotate and scale with all three pivots, verified world and active-local coordinates in exported GLB data, and reopened a project with the same transforms. A remapped shortcut survived reload and stayed inactive in a text input. |

## Independent interchange checks

- ufbx compared the selected FBX body against the original two-mesh fixture. All 40 control points, 76 triangles, connectivity, raw weights and bind matrices matched. Across 21 clip samples, maximum world deformation error was `3.38e-8 m`.
- Unity 2022.3.62f2 and 6000.3.9f1 each imported the selected body with the three-joint chain. Base positions, bind poses and weights matched. Maximum deformation error over 21 samples was `2.82e-7 m` in both versions.
- The selected Tripo character GLB was exported while offline. An independent reader verified 17,623 triangles, 67 joints, exact vertex attributes and indices, and byte-identical embedded Base Color and Normal maps. The maximum base and bent pose errors were approximately `1.01e-7 m`. Khronos Validator 2.0.0-dev.3.10 reported zero errors and three warnings associated with generated tangents and retained skinned node transforms or placement.

Object transforms apply to static meshes and groups with representable local TRS transforms. Skin and bone edits use Rig & Pose. Selection picking uses geometric visibility. Numeric textures in the FBX Phong profile are supplied for explicit assignment in Unity. The import limit is 8192 pixels per side and 512 MiB estimated across decoded maps. Texture editing and direct UV baking are capped at 4096 pixels per side.

## Reproduction

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/v1-browser.mjs
node tools/v1-browser.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' edge
python -B tools/e00/inspect_glb.py 'D:/downloads/Tripo/man character 3d model.glb' test-results/v1/chrome/tripo-selection.glb
node tools/e00/validate-glb.mjs 'D:/downloads/Tripo/man character 3d model.glb' test-results/v1/chrome/tripo-selection.glb
python -B tools/v1-unity.py 2022.3.62f2 6000.3.9f1
python -B tools/e12-package.py
```

Use the existing pinned [Playwright, validator and ufbx setup](E12_Report.md#reproduction-and-artifacts). Run `inspect_fbx.exe tools/e00/fixtures/shared_skin.fbx test-results/v1/chrome/selected.fbx --selected-skin` after building the probe. Run `SharedSkinProbe.RunSelection` with each Unity editor in batch mode using the projects generated under `test-results/v1/`. The generated GLB assembly is defined in `tools/v1-browser.mjs`. The private Tripo fixtures and generated exports stay local.
