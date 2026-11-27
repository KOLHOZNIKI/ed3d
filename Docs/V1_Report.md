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
| PAINT2D-05 | Face and UV-island picks rasterize to a texel mask. A two-face fixture verified that Fill left the other face unchanged, Clone Stamp could read outside the mask, Undo restored the previous pixels, and the island mask covered both connected faces. |
| PROJECT-03, AT-27, SC-06 | Two pinned revisions reopened offline with distinct pixels in their original states. The current image and the matching pin shared a blob. The browser restored brush settings, opened the pinned comparison and undid removal of a pin. Pins share the regular Save As and autosave paths. |
| §7.4 | The explicit PNG option reopens in AssetFixer with the changed FBX paths. Independent decode checked one 8192² plate map and four 4096²/2048² character maps. Dimensions matched and maximum channel difference between decoded JPEGs and PNGs was one code value. |
| CORE-07, §6.5 | Topology commands return stable-ID replacements and interpolation sources for generated vertices. Split and Fan Fill have positive core fixtures. Cancellable jobs publish an ID, base revision, SHA-256 input fingerprints, visible progress and completion state. The E12 cancellation, worker failure and stale-revision cases verify that incomplete candidates preserve the working model. |

## Required workflow audit

The table traces the user requirements in §2.2 to positive fixtures and acceptance evidence. §22.3 cases AT-01 through AT-32 are individually recorded in [the E12 acceptance matrix](E12_Report.md#mandatory-test-coverage). The repeat run includes the stage browser tests, the Workspace and UV Stitch regressions, and dedicated V1 tests in Chrome and Edge. The rejection tests exercise unsupported data and deliberately failed operations alongside successful fixtures.

| Required IDs | Positive evidence |
| --- | --- |
| USR-01, USR-02 | The WebGL2 workspace, offline launch, real FBX and GLB exchange, material assignment, selection export and PNG conversion. [Workspace](Workspace_Report.md), [E12](E12_Report.md). |
| USR-03, USR-04 | Seam-crossing 3D brush, frozen skin, 2D brush and stamp, scalar maps, face/island masks and PNG output. [E02](E02_Report.md), [E03](E03_Report.md), V1 browser tests. |
| USR-05, USR-06, USR-16 | Stable vertex, edge and face editing, UV corners and islands, and ordered triangles, quads and longer contours. [E04](E04_Report.md), [E05](E05_Report.md), [E06](E06_Report.md). |
| USR-07, USR-08 | Painted snapshot transfer, xatlas, UV packing, tangent-normal transfer and constrained projection with cancellation. [E06](E06_Report.md), [E08](E08_Report.md). |
| USR-09, USR-10, USR-11, USR-12 | Shared-rig editing and rebind, frozen weight painting, ten diagnostic motions, manual and named poses, Unity import. [E09](E09_Report.md), [E10](E10_Report.md), [E11](E11_Report.md). |
| USR-13, USR-14 | Independent extraction, texture ownership, pivot and batch packaging. [E07](E07_Report.md). |
| USR-15 | Protected openings, Planar, Fan, Smooth, Grid and Bridge, and independently imported repairs. [E05](E05_Report.md), [E08](E08_Report.md). |
| USR-17 | Immutable originals, offline project recovery, archived pins, Undo and controlled refusal of unsupported inputs. [E01](E01_Report.md), [E12](E12_Report.md), V1 browser tests. |

The production ZIP contains the offline bundle and licenses. The repository contains the locked source, fixture provenance, archive migrations, format matrix, stage changelog and reproduction instructions required by §23.1. Private Tripo references and generated exchange artifacts stay in the local test directory.

## Independent interchange checks

- ufbx compared the selected FBX body against the original two-mesh fixture. All 40 control points, 76 triangles, connectivity, raw weights and bind matrices matched. Across 21 clip samples, maximum world deformation error was `3.38e-8 m`.
- Unity 2022.3.62f2 and 6000.3.9f1 each imported the selected body with the three-joint chain. Base positions, bind poses and weights matched. Maximum deformation error over 21 samples was `2.82e-7 m` in both versions.
- The selected Tripo character GLB was exported while offline. An independent reader verified 17,623 triangles, 67 joints, exact vertex attributes and indices, and byte-identical embedded Base Color and Normal maps. The maximum base and bent pose errors were approximately `1.01e-7 m`. Khronos Validator 2.0.0-dev.3.10 reported zero errors and three warnings associated with generated tangents and retained skinned node transforms or placement.
- The PNG-mode Tripo plate and character passed Unity 2022.3.62f2 and 6000.3.9f1 with zero base-position error. ufbx matched polygon connectivity and corner UVs exactly. The character retained its 67 joints and raw skin weights. The Phong FBX linked Base Color and Normal, and the package supplied the remaining data maps for manual Unity assignment.
- The authored Kenney clip was checked in both Unity versions and in ufbx at 21 evenly spaced samples and 24 distinct extrema or endpoint times from source and output curves. The maximum ufbx deformation error was `1.03e-6 m`, below the `5.33e-4 m` fixture tolerance.

## Workstation measurements

The RTX 3070 work-PC run at 1920 × 1080 and DPR 1 measured `16.8 ms` p95 frame time and `1 ms` p95 object selection. The 2K and 4K paint response p95 values were `1.4 ms` and `1.1 ms`. The direct bakes took `4.03 s` and `11.14 s`. The 50,000-triangle unwrap took `0.55 s`. Initial progress appeared within `164 ms` on all measured jobs. Cancellation acknowledgment was `13.6 ms`. The 250,000-triangle projection took `7.69 s` at 256². Generated timings are in `test-results/e12/benchmark-v1-final.json`.

Six import, unwrap, bake, export and close cycles left zero active workers after every close. The Chrome process tree used 381 MiB of private memory at baseline, peaked at 1,733 MiB and retained 982 MiB after the last close, forced garbage collection and 20 seconds of idle time. The JavaScript heap settled at 8.05 MiB from a 4.75 MiB baseline. The private-byte counter includes the browser and its subprocesses. Raw measurements are in `test-results/e00/memory/v1-audit.json`.

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
python -B tools/v1-unity.py --external-png 2022.3.62f2 6000.3.9f1
python -B tools/e12-package.py
```

Use the existing pinned [Playwright, validator and ufbx setup](E12_Report.md#reproduction-and-artifacts). Run `inspect_fbx.exe tools/e00/fixtures/shared_skin.fbx test-results/v1/chrome/selected.fbx --selected-skin` after building the probe. Run `SharedSkinProbe.RunSelection` with each Unity editor in batch mode using the projects generated under `test-results/v1/`. The generated GLB assembly is defined in `tools/v1-browser.mjs`. The private Tripo fixtures and generated exports stay local.

For PNG validation, run `FbxProbe.Run` on both generated `unity-png-*` projects and check `e00-report.json`. For authored clip extrema, pass `--clip-extrema` with the pinned Kenney FBX and `test-results/v1/chrome/authored-current.fbx` to the independent reader.
