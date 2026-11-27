# E12 full acceptance

This report covers the supported V1 profile in [§§7, 19–23 of the specification](AssetFixer_Technical_Specification_v1.0.md#sec-07). The [format and project reference](Formats_and_Projects.md) describes conversion rules, limits and archive migrations. The [changelog](../CHANGELOG.md) maps USR-01 through USR-17 to their implementation stages. The [user guide](../README.md) describes the operating workflows and pinned dependencies.

## End-to-end results

Chrome 158.0.8127.37 and Edge 158.0.4370.45 ran the production bundle on the Windows workstation. The browser cached the static build, reloaded with the network disabled, imported a local FBX ZIP and ran xatlas and the texture worker. The test painted 792 red texels across the folded fixture and counted 5,429 red texels after transfer to a 256 × 256 atlas. The export still contained ten triangles. The baked PNG was byte-identical after saving, closing and reopening. It also reopened and exported the real Tripo plate and Tripo skinned GLB without network requests.

The FBX ZIP contains the model, maps, `manifest.json`, `report.json` and `report.txt`. Whole-scene, standalone and batch reports give their export scope and list the files. GLB reports are available from the diagnostics panel. The report preserves the original hashes, records supported conversions and findings, and leaves external reimport status pending for the exported file.

| Workflow | Accepted output |
| --- | --- |
| Static asset | FBX open → seam paint → unwrap → working-snapshot bake → export → save and reopen. The real plate round-trip preserved 4,577 control points, 5,134 polygons, 9,138 triangles, original UVs and linked map bytes. Unity retained one bound Base Color texture. [E06 visual comparison](E06_Report.md) |
| Batch | Component extraction → pack → independent map bake and paint → pivot → individual export and batch ZIP. The two FBX outputs keep their own texture data and pivots. The batch and its items carry scoped export reports. [E07 verification](E07_Report.md) |
| Character | Map roles → calibrate → run the ten motions → freeze and paint weights → play the same section → save and reopen → publish and export. The FBX contains 25 bones and 11 takes. ufbx samples all 11 at 21 frames each and checks the expected deformation. Unity imports the Generic rig and the explicitly mapped Humanoid Avatar. [E11 verification](E11_Report.md) |

Each import failure leaves the current document intact. The missing-map fixture accepted a local PNG and reopened using only the saved project. The folder fixture retained relative paths. The non-manifold fixture exposed an actionable finding, and exporting the FBX morph fixture was refused with its exact source still downloadable. Cancelling UV transfer or injecting an error in its worker left its painted revision intact. A stale command in the core check left both the committed state and Undo history unchanged.

## Unity and independent readers

| Import or reader | Coverage |
| --- | --- |
| Unity 2022.3.62f2 and 6000.3.9f1, Generic | The production plate export matched the original with zero measured base position error and one Base Color binding. E11 checks the skinned fixture bind, UVs, edited weights, all exported takes and independent skin predictions at 21 frames per take. [Static and animated baselines](E00_FBX_Round_Trip.md) |
| Unity 2022.3.62f2 and 6000.3.9f1, Humanoid | The source and export both produced valid human Avatars with the 17 explicitly chosen roles, 25 skin joints and 510 Unity render vertices. The source take moved the skinned mesh by 0.102 m in each file. Sampled maximum visible displacements in the export were 0.497 m for Squat, 0.875 m for Wave and 0.729 m for Walk. All 11 imported clips were Humanoid clips. |
| ufbx v0.23.0 | The production plate output matched polygon connectivity, corner UVs, axes and units. Maximum normal error was 0.00000121°. The E11 animated FBX preserved the base and binding, changed the three intended control-point weight rows, and passed independent deformations for all takes. |
| Independent GLB reader and Khronos Validator 2.0.0-dev.3.10 | The Tripo GLB retained 17,623 triangles and 67 joints. Positions, normals, UVs, joint indices, weights, indices and both linked images were exact. The bind and bent position errors were approximately 0.10 μm after the documented affine rounding. The exported validator result had zero errors and three warnings for generated tangent space and the retained skinned node placement and local transforms. GLB verification uses the independent reader and validator. |

Unity baseline settings used source normals, calculated MikkTSpace tangents, standard four-influence skinning and disabled mesh compression, animation compression and mesh optimization. The Humanoid test applied its 17-role mapping after the first source skeleton import. The probe verifies Unity's actual runtime bone mapping and bakes the posed mesh from a manual animation graph. The reported measurements cover these fixtures and settings.

## Mandatory test coverage

| Test | Result and evidence |
| --- | --- |
| AT-01 | Static FBX geometry, maps, axes/units and report checked in ufbx and two Unity versions. [E00](E00_FBX_Round_Trip.md) |
| AT-02 | Real authored FBX clip, source timing, bind and sampled deformation retained for the supported Generic profile. [E00](E00_FBX_Round_Trip.md) |
| AT-03 | PNG-only edit preserved the original FBX SHA-256. [E02](E02_Report.md) |
| AT-04 | 2D Brush, Clone Stamp and 3D Brush combined in the exported PNG with no overlay pixels. [E02](E02_Report.md) |
| AT-05 | Fast strokes retained spacing and brush size through zoom changes. [E02](E02_Report.md) |
| AT-06 | The stamp sampled its stroke-start snapshot in the overlap case. [E02](E02_Report.md) |
| AT-07 | Painted UV seam was continuous, with no unrelated back-side changes. [E03](E03_Report.md) · [E00 Unity paint](E00_3D_Brush.md) |
| AT-08 | Painted snapshot survived a second unwrap and direct bake in the production workflow and Unity plate comparison. [E06](E06_Report.md) |
| AT-09 | A shared UV vertex moved only its own authored corners. [E06](E06_Report.md) |
| AT-10 | Cancel preserved the accepted painted revision and map bytes. [E06](E06_Report.md) |
| AT-11 | A valid skinned unwrap retained topology and weights. Unsupported FBX morph export was explicitly blocked. [E06](E06_Report.md) · [E00 morph fixture](E00_F13.md) |
| AT-12 | Directional normal bake matched lighting across rotated and mirrored UVs. Maximum measured normal angle error was 0.517°. [E00 normals](E00_Directional_Normals.md) · [E06](E06_Report.md) |
| AT-13 | Conflicting target UVs were refused before applying; the new hierarchy passes isolated pair comparisons and preserves shared edges. [E06](E06_Report.md) |
| AT-14 | Projection used only the eligible close surface and exposed misses. [E08](E08_Report.md) · [E00 close surfaces](E00_F15.md) |
| AT-15 | Separate, pack, bake and pivot produced independent static FBX outputs. [E07](E07_Report.md) |
| AT-16 | Painting the extracted object left the original shared texture unchanged. [E07](E07_Report.md) |
| AT-17 | Auto Fill closed both bottle defects and kept the mouth open. [E05](E05_Report.md) |
| AT-18 | Planar, Fan, Smooth, Grid and Bridge passed positive fixtures with valid winding and connected patch boundaries. [E05](E05_Report.md) · [E08](E08_Report.md) |
| AT-19 | Manual Face uses ordered 3-, 4- and 6-point fixtures, reversible winding and overlap refusal. [E04](E04_Report.md) · [E05](E05_Report.md) |
| AT-20 | Split and Weld retained connected geometry and corner UV and normal seams. [E04](E04_Report.md) |
| AT-21 | Editing and undoing a shared joint preserved both bound meshes. [E09](E09_Report.md) |
| AT-22 | Manual pose and Reset preserved the exported rest and bind. [E09](E09_Report.md) |
| AT-23 | Locks survived edits. The explicit fifth-influence conflict preserved the old row. [E10](E10_Report.md) |
| AT-24 | Smoothing followed edge-connected neighbors on the intended finger. [E10](E10_Report.md) |
| AT-25 | Ten offline diagnostic clips ran with a persisted configuration and recoverable poses. [E11](E11_Report.md) |
| AT-26 | A rest change marked prior clip recipes stale and required adaptation, republication or explicit exclusion. [E09](E09_Report.md) · [E11](E11_Report.md) |
| AT-27 | Source-free archive reopen restored texture edits, bakes, hierarchy and poses. [E01](E01_Report.md) · [E06](E06_Report.md) · [E11](E11_Report.md) |
| AT-28 | Cancellation, injected bake error and a stale command preserved the accepted state. [E06 cancellation](E06_Report.md) · [E12 browser](../tools/e12-browser.mjs) · [E12 core](../tools/e12-core.mjs) |
| AT-29 | Forced WebGL context loss and restoration retained completed edits. [E01](E01_Report.md) · [E03](E03_Report.md) |
| AT-30 | Storage quota, an archive declared over the memory preflight limit, and refused morph export left the open state usable. Heavy memory limits and repeated Undo have separate measured evidence. [E01](E01_Report.md) · [E00 heavy history](E00_F18.md) |
| AT-31 | Non-manifold topology, missing texture and unsupported morph cases produced explicit diagnostics. [E12 browser](../tools/e12-browser.mjs) |
| AT-32 | Static, batch and character workflows produced the usable outputs listed above. |

## Performance and memory

The benchmark used Windows 11 Pro build 26300, a Ryzen 9 9950X3D with 16 cores and 32 threads, 61.58 GiB of usable RAM, Chrome 158.0.8127.37, and the RTX 3070 through ANGLE D3D11 with driver 32.0.16.2124. The WebGL2 drawing buffer was 1920 × 1080 at DPR 1. The user confirmed that this workstation is their work PC. The interactive and repeated memory measurements used separate dedicated Chrome sessions.

The typical FBX contains 50,000 triangles, 100 bones and four 2K maps. The 2K and 4K single-map profiles retain its geometry and skin. The frame benchmark drives continuous camera input for 120 frames. Brush latency measures 20 warm input-to-tile-draw samples at each size in the 2D editor. Selection measures synchronous input handling on the loaded typical asset. The long-task timings include UI preparation, worker completion and applying the result. Progress is measured at the first animation frame after the initial status update.

| §20.2 metric | Target | Measured |
| --- | ---: | ---: |
| Typical interactive frame interval, p95 | ≤33 ms | 16.8 ms |
| 2K brush response, p95 | ≤50 ms | 0.7 ms |
| 4K brush response, p95 | ≤100 ms | 0.8 ms |
| Typical object selection, maximum of 30 | ≤100 ms | 5.6 ms |
| Initial progress, maximum of measured jobs | ≤500 ms | 95.8 ms |
| Cancellation acknowledgment | ≤1,000 ms | 297 ms |
| Auto unwrap, 50,000 triangles | ≤20 s | 0.44 s from Generate UV Atlas, 1.67–2.32 s in the UV Editor |
| Direct working-image bake, one 2048 × 2048 map | ≤5 s | 3.49 s |
| Direct working-image bake, one 4096 × 4096 map | ≤20 s | 8.59 s |
| Heavy spatial bake, 250,000 triangles and one 4K source | Separate measurement | 6.79 s at 256 × 256 output, zero unresolved texels |

Dense UV layouts use a sampled wire preview at fit view. Zooming shows finer detail. Layout grouping, selection, overlap checks, and export still use all authored triangles. The first direct-bake pass spent about 14.64 s at 2K and 20.01 s at 4K with full wire drawing. The final figures include the preview optimization and transfer from the current painted snapshot. Heavy projection timing is specific to the eligible source, radius, output dimensions and mesh in the test.

The separate work-PC session ran six import → unwrap → four-map rebake → export → close cycles. The median sample interval was 31 ms across 2,143 process-tree samples.

| Phase | Peak private commit | Peak summed working set | Elapsed range |
| --- | ---: | ---: | ---: |
| Import | 1,631 MiB | 1,539 MiB | 0.44–0.59 s |
| Unwrap | 1,545 MiB | 1,440 MiB | 0.43–0.50 s |
| Four-map rebake | 1,686 MiB | 1,611 MiB | 2.59–2.86 s |
| Export | 1,673 MiB | 1,525 MiB | 0.46–0.52 s |

Each close left zero active workers. Private commit was 380 MiB at the empty baseline, 1,495 MiB after the sixth close, 1,005 MiB after diagnostic garbage collection and 748 MiB after another 20 seconds idle. Page backing storage fell from 94.6 MiB after the last close to 3.4 MiB after collection, versus 1.5 MiB at baseline. The measurements show resource reclamation and retained browser-process memory above baseline after idle.

The last export retained all 25,326 control points, 50,000 triangle boundaries, original corner UVs and raw skin weights in ufbx. The independent report is `test-results/e00/memory/e12-work-pc-ufbx.json`.

The comparable heavy F18 run retained seven independently readable checkpoint ZIPs for 24 strokes and 24 Undo operations. The 250,000-triangle exports preserved positions, original corner UVs and connectivity. CPU process counters include Chrome's renderer and GPU process private commit. Dedicated VRAM and abrupt OS termination under memory exhaustion are outside the measurement. [F18 measurements](E00_F18.md) · [Memory measurement method](E00_Memory.md#measurement-method)

To reproduce the performance and separate work-PC runs in the production build:

```powershell
node tools/e00/memory-fixture.mjs
node tools/e00/memory-fixture.mjs --single-2k
node tools/e00/memory-fixture.mjs --single-4k
node tools/e00/memory-fixture.mjs --heavy-paint
node tools/e12-benchmark.mjs
node tools/e00/memory-browser.mjs test-results/e00/memory/typical_memory.zip --cycles 6 --idle-seconds 20 --label e12-work-pc
```

The timings are written to `test-results/e12/benchmark-chrome.json`. The sampled memory data and exported round-trip are in `test-results/e00/memory/e12-work-pc.json` and `e12-work-pc-export.zip`.

## Reproduction and artifacts

Use Node.js 22.12 or later, the locked dependencies, Python, Windows Chrome and Edge, pinned Playwright 1.65.1, ufbx v0.23.0 and Unity 2022.3.62f2 and 6000.3.9f1. Private Tripo references are local to `D:/downloads/Tripo`. Source permissions and source hashes are recorded with the [Tripo and format fixtures](E00_Report.md#fixture-provenance), [project-owned corpus](E00_Corpus.md) and [Meshy fixture](E00_F17.md). The procedural character, folded mesh and paint fixture are generated by the project under the repository license.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run build:debug
npm.cmd install --prefix test-results/e00-browser playwright-core@1.65.1
npm.cmd install --prefix test-results/e00-glb-validator gltf-validator@2.0.0-dev.3.10
node tools/e03-fixture.mjs
node tools/e11-fixture.mjs
node tools/e12-core.mjs
python tools/e12-package.py
node tools/e12-browser.mjs
node tools/e12-browser.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' 'D:/downloads/Tripo' edge
node tools/e11-browser.mjs
python tools/e12-verify.py
node tools/e00/validate-glb.mjs 'D:/downloads/Tripo/man character 3d model.glb' test-results/e12/chrome/tripo-character.glb
python tools/e12-unity.py 2022.3.62f2 6000.3.9f1
python tools/e12-unity.py 2022.3.62f2 6000.3.9f1 --static 'D:/downloads/Tripo'
```

Before the independent verification, build `inspect_fbx.exe` and `e11-fbx.exe` with the pinned ufbx checkout and the x64 compiler. The commands are in the [FBX baseline reproduction](E00_FBX_Round_Trip.md) and [character reproduction](E11_Report.md). Run the generated Unity projects with `-batchmode -nographics -quit`. Use `-executeMethod E12HumanoidProbe.Run` for the Humanoid projects and `-executeMethod FbxProbe.Run` for the static projects. Retain each JSON report and Unity log in its project directory.

The Release static build is in `dist/`. The deployable ZIP under `test-results/e12/AssetFixer-release.zip` contains the built application and license notices. Serve the extracted directory over HTTP on localhost or HTTPS. For example, run `python -m http.server 4173 --bind 127.0.0.1`. The generated test outputs are stored in `test-results/e12/chrome/`, `test-results/e12/edge/`, `test-results/e07/` and `test-results/e11/`. These directories contain the static FBX and baked PNG, reopened projects, batch FBX and GLB packages, and skinned FBX and GLB exports.
