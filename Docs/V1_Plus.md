# V1+ scope and verification

The specification lists the following extensions after mandatory V1. The order in the repair list comes from [§9.2](AssetFixer_Technical_Specification_v1.0.md#92-proposed-additional-repair-tools).

| Extension | Status |
| --- | --- |
| Soft Selection with adjustable radius and falloff | Verified below |
| Smooth Selection with fixed boundaries | [Verified](#smooth-selection) |
| Flatten Selection to a selected or averaged plane | [Verified](#flatten-selection) |
| Simple Extrude for a boundary or region | [Verified for static meshes](#simple-extrude) |
| Subdivide a selection with compatible adjacent faces | [Implemented and checked](#mirror-move-and-subdivide) |
| Mirrored movement with a matching tolerance | [Implemented and checked](#mirror-move-and-subdivide) |
| UV Stitch / Weld (UV-12) | [Single-edge workflow verified](UV_Stitch.md) |
| UV Relax (UV-16) with fixed boundaries and visible UV pins | [Implemented and checked](#uv-relax) |
| Make the current pose the new base pose | [Verified for supported skins](#make-the-current-pose-the-base-pose) |

The UV work is described in §11.2 and §11.6 of the specification. §16.6 reserves the base-pose command for a separate geometry and animation bake.

## Soft Selection

**Mesh Edit** offers Soft Selection for Move, Rotate and Scale from vertex, edge and face selections. The radius is measured along the shortest path from any selected vertex, using edge lengths in the mesh's local coordinates. The selected vertices receive the full transform. **Linear**, **Smooth** and **Sharp** control the decrease toward zero at the radius. Render copies at UV and hard-normal seams move together when they share a logical vertex. Disconnected pieces, including coincident vertices, remain outside the propagation path.

Numeric input and the axis handles use the existing preview and apply workflow. In the preview, orange points indicate influenced neighbors. Applying creates one Undo entry. The edit keeps the original vertex and corner IDs and reuses the regular mesh transform path for geometry validation and local normal and tangent updates. Skin weights and UVs stay attached to their existing vertices and corners. Skinned transforms apply in the working rest geometry. The radius follows mesh edges, so its reach depends on the mesh's edge layout and local scale.

A project with a Soft Selection command or saved Soft Selection preferences uses archive schema 15. The replay log stores the seeds, transform, radius and falloff. It recalculates influence from the topology at the recorded step.

## Verification

- The Chromium browser check applied a linear move to both fixtures, cancelled a preview, refused a zero radius, and exercised Smooth Rotate and Sharp Scale. It exported Undo and offline reopen results. Both moved FBX packages retained the linked PNG bytes. Release and Debug built with strict type checking. E01, E04 and V1 browser regressions passed on Release.
- The F01/F02 cube fixture moved seven logical control points, including the selected point. The detached vertex at the same position stayed fixed. ufbx found exact polygon connectivity and corner UVs, a 90° hard normal split at the seed and a maximum position error below `2e-18 m` against its independent distance calculation.
- The generated elbow fixture moved three control points. ufbx found exact connectivity, UVs and weights and zero position error. The `Bend` clip retained its name and timing. Its 21 sampled deformations matched an independently edited source mesh. The Undo exports matched the original positions and the reopened exports matched the predicted edit for both models.
- Unity 2022.3.62f2 and 6000.3.9f1 imported both FBX files with the expected triangle connectivity, UVs and linked Base Color. The maximum position discrepancy was `4.66e-10 m` on the cube and zero on the elbow. Both editors measured zero weight and posed-position error over 21 elbow clip samples. The probe uses the existing Generic rig profile, imported normals, calculated MikkTSpace tangents, standard skin weights and disabled mesh and animation compression.

## Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
npm.cmd run build:debug
node tools/e03-fixture.mjs
node tools/soft-selection-browser.mjs $chrome
python -B tools/soft-selection-unity.py 2022.3.62f2 6000.3.9f1
```

Run both generated projects in Unity batch mode with `-executeMethod FbxProbe.RunSoftSelection`. Compile the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows). Compare the original FBX in each Unity fixture directory with `static.fbx` or `skinned.fbx` under `test-results/soft-selection/`. Pass `--soft-move 1.5` for the cube and `--soft-move 1.25` for the elbow. Use the same radius for `-reopened.fbx` and `--soft-move 0` for `-undone.fbx`. The generated exports, preview and reports are under `test-results/soft-selection/`.

## Smooth Selection

Use **Mesh Edit → Smooth Selection** for a vertex, edge, or face selection. Strength sets the fraction of the distance to the mean of the neighboring vertices on each of 1–50 iterations. Every iteration reads the same position snapshot for all selected vertices. **Fix boundary** pins the selection perimeter and any selected vertices on open or non-manifold edges. In vertex and edge modes, the selected surface consists of faces with all corners selected. The preview reports the moved and pinned counts and marks the pinned boundary on edge and face selections. A selection with every vertex pinned cannot be applied.

Vertices outside the selection retain their positions. The edit preserves logical topology, per-corner UVs, materials and skin weights. The shared deformation path validates the resulting triangles and updates local normals and tangents. Uniform smoothing can shrink unpinned geometry at high strengths or iteration counts. Applying is one Undo entry. Projects with smoothing commands or preferences use schema 16 and replay the selection and settings offline.

### Verification

- The Chrome test used a 5 × 5 FBX grid with eight selected faces around a raised center and an unselected outer ring. At strength 0.5 for two iterations, the center height went from `0.5 m` to `0.125 m`. ufbx measured zero displacement for all eight perimeter vertices and all 16 vertices outside the selection, both immediately and after reopening the project offline. Undo restored all 25 positions. With **Fix boundary** off, all nine selected vertices moved.
- The browser also checked the open rim of the full grid, the equivalent vertex selection, an edge selection with no interior, invalid strength, preview cancellation and Redo. The exports retained exact polygon connectivity, corner UVs and linked PNG bytes. Release and Debug built, and the E01, E04, Soft Selection and V1 browser regressions passed.
- The skinned grid repeated the same position checks. Unity 2022.3.62f2, Unity 6000.3.9f1 and ufbx found zero expected-position and weight error. All 21 samples of `GridBend` matched the independently modified source. The Unity probe used the standard Generic import profile with source normals and mesh and animation compression disabled.

### Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
node tools/e03-fixture.mjs
node tools/smooth-selection-browser.mjs $chrome
python -B tools/smooth-selection-unity.py 2022.3.62f2 6000.3.9f1
```

Run both generated Unity projects in batch mode with `-executeMethod FbxProbe.Run` and check `e00-report.json`. In `test-results/smooth-selection/`, use the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows) to compare `static-original.fbx` with `static.fbx` and `static-reopened.fbx`, and `skinned-original.fbx` with `skinned.fbx` and `skinned-reopened.fbx`. Pass control point `12` and Y offset `-0.375` for each edit. Check `maxDeltaOutsideControlPoint` in the position edit report. Compare the `-undo.fbx` and `static-unpinned.fbx` files without edit arguments to see their changed point counts.

## Flatten Selection

**Mesh Edit → Flatten Selection** projects the logical vertices of a vertex, edge, or face selection orthogonally onto a plane. **Best Fit** minimizes the sum of squared perpendicular distances using all selected vertices with equal weight. The fitted plane goes through their centroid. **XY**, **XZ** and **YZ** use an object-local axis normal. **Custom** uses an entered normal. For a specified plane, the signed offset is measured in object-local units along the normalized normal from the object origin.

The edit validates triangles affected by the projected positions and updates their normal and tangent frames. Vertices outside the selection keep their coordinates. Best Fit needs three or more non-collinear points with a well-defined plane. An ambiguous fit can be resolved by specifying the plane. Preview, Undo/Redo and offline replay use the normal Mesh Edit workflow. Projects with flattening commands or preferences use schema 17.

### Verification

- Chrome applied an XZ plane at `Y = 0.25 m` to two edge vertices. Both were on the plane exactly. The other 23 points retained their coordinates. The test also refused collinear vertices for Best Fit, a zero custom normal and a projection that would collapse a triangle.
- The custom tilted plane moved the nine selected points on the static grid. The maximum perpendicular distance measured with ufbx was `2.23e-16 m`. Best Fit projected nine points of the tilted skinned grid within `1.33e-8 m` of the analytic plane. The other 16 control points in each case kept their exact coordinates. Undo restored all positions. Redo and offline reopening reproduced both edits.
- The exports kept polygon connectivity, corner UVs, texture bytes and skin weights. Unity 2022.3.62f2 and 6000.3.9f1 both imported the static and animated FBX against analytically projected reference files. The largest vertex discrepancy in Unity was `5.96e-8 m`. Across 21 clip samples, the maximum deformation error was `1.20e-7 m` in Unity and `3.33e-8 m` in ufbx. Release and Debug built, and the E01, E04, V1, Soft Selection and Smooth Selection browser regressions passed.

### Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
node tools/e03-fixture.mjs
node tools/flatten-selection-browser.mjs $chrome
python -B tools/flatten-selection-verify.py 2022.3.62f2 6000.3.9f1
```

Before running the Python verification, build the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows) and place `inspect_fbx.exe` under `test-results/flatten-selection/`. The verifier checks the exported control points and prepares both Unity projects. Run them in batch mode with `-executeMethod FbxProbe.Run`. Reports and FBX exports are under `test-results/flatten-selection/`.

## UV Relax

In **UV Editor**, select **UV Relax** and optionally pin vertices with **Pin selected**. Pins are scoped to the current object and UV channel within the draft. Select the region, set strength and 1–50 iterations, and click **Update draft**. The operation moves selected UV vertices toward their edge-connected neighbors, weighted by inverse 3D edge length. **Fix boundary** holds chart edges and the edges of the selection. The candidate is refused if affected triangles collapse, flip, or overlap another triangle. Packing holds any island with pins fixed. Clear pins before Auto Unwrap. Applying or cancelling the draft clears its pins. The applied UV coordinates are saved and can be undone. Use **Preserve Appearance** to rebake the current texture onto the revised layout.

In Chrome, an FBX grid retained its 16 boundary UV vertices and one explicit interior pin in both the static and skinned cases. The displaced center went from `0.10198` to `0.01590` UV units from its regular position. ufbx read the same coordinates after offline project reopen. A separate Preserve Appearance run produced a 256² gradient Base Color map with zero missing occupied texels. The core checks refused both an overlapping UV edit and a collapsed triangle.

## Mirror Move and Subdivide

**Mirror Move** uses an object-local axis plane with a signed offset and a match tolerance. Select the source side and preview the translation. Opposite-side matches must be unique in both directions. Vertices matched to themselves move along the plane, and the preview lists unmatched, ambiguous, and two-sided selections. Those unresolved pairs stay in place. On the test grid, the offsets on the matched pair were `(+0.125, +0.0625, 0)` and `(-0.125, +0.0625, 0)` meters. The center vertex moved by `+0.0625 m` along Y. ufbx matched all other positions exactly, as well as UVs, polygon connectivity and skin weights.

**Subdivide** splits each triangle in the selected faces into four, following the existing triangulation of n-gons. It inserts shared midpoints into adjoining polygons and updates their triangulation, preserving the original surface and avoiding T-junctions. Each midpoint retains its source edge and interpolates weights, morph deltas and corner attributes. The two sides of a UV seam keep independent corners. Affected non-manifold edges and unsupported GLB skin influence counts are refused.

On the grid, one selected face became four. Three neighboring faces each acquired the same midpoint as the selected side. ufbx verified all three shared edges, 28 control points, 38 triangles, unchanged original positions, interpolated UVs and exact expected weights. A separate core case verified a subdivided GLB n-gon, a marked UV seam and interpolated morph deltas. Undo restored the originals and offline replay restored the changes for all three tools. The three skinned FBX exports matched their expected deformation over 21 clip samples in ufbx.

Unity 2022.3.62f2 and Unity 6000.3.9f1 imported all six static and skinned exports with the expected triangle counts and positions. Both editor versions measured zero skin weight and deformation error over 21 clip samples for each skinned fixture. The probe used the Generic profile, imported normals, calculated MikkTSpace tangents, and disabled mesh and animation compression.

### Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
node tools/e03-fixture.mjs
node tools/v1-plus-tools-core.mjs
node tools/v1-plus-tools-browser.mjs $chrome
python -B tools/v1-plus-tools-verify.py 2022.3.62f2 6000.3.9f1
```

Before running the Python verifier, compile the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows) and place `inspect_fbx.exe` under `test-results/v1-plus-tools/`. The browser runner serves the Release files through local Playwright responses. The verifier checks the exported geometry and builds the Unity comparison projects for `FbxProbe.Run`. Both reports and test assets are under `test-results/v1-plus-tools/`.

## Simple Extrude

In **Mesh Edit → Extrude**, use Edge mode with one connected open chain or loop. After committing, the selection follows the new outer edge. In Face mode, translate one edge-connected face region and join its perimeter with side quads. The translated faces retain their IDs, UVs and materials. Enter a signed depth along the averaged surface normal or an object-local axis. The tool checks winding, collapsed triangles and intersections before allowing the edit. Boundary protection follows the new edge when the original perimeter was marked **Keep Open**.

The side quads inherit the adjacent material. Extrude lays out separate UV strips in conservatively estimated free space of the object's existing tile, preserving all original corner UVs. If the tile is full or the source UVs extend outside it, the walls receive provisional coordinates and a UV-review warning. Unwrap or pack a new layout and use neutral fill where the new surface has no source. Projected side faces appear in the **New faces** paint mask. The first profile supports static meshes without skin or morph targets. Projects with Extrude commands or preferences use schema 19.

### Verification

- The static edge fixture extended two connected open edges by `0.25 m`. It exported 36 triangles, including two side quads. The face fixture raised two adjacent faces by `0.125 m`. It exported 40 triangles with four side quads. ufbx found the expected shared edges, correct new positions and 25 unchanged source positions in both cases. The 96 original corner UVs and linked PNG bytes matched. All side UV quads occupied free space in the source tile.
- Chrome verified Preview and Cancel, the new-face paint mask, a filled UV tile warning, an interior edge refusal and the static-mesh guard. Undo restored source data and offline project replay reproduced both exports. Core checks covered an open loop, protected boundary remapping, GLB UV orientation and refusal of an intersecting extrusion.
- Unity 2022.3.62f2 and 6000.3.9f1 imported both exports with 36 and 40 triangles, linked Base Color, and zero base-position error against independent reference geometry. Both Release and Debug built with strict type checking. The E04 browser regression and the V1+ checks for UV Relax, Mirror Move and Subdivide passed on the same build.

## Make the current pose the base pose

In **Rig & Pose → Manual pose**, pose the joints and choose **Make Current Pose the Base Pose**. The command bakes the displayed skin deformation into every mesh driven by the affected rig and rebuilds the inverse bind matrices. It clears the manual pose, keeping the baked shape on screen. UVs, materials, topology and supported weight rows stay attached to the same elements. Undo and Redo restore both the geometry and rig in one step. Saved poses keep their absolute joint transforms and can deform the rebased mesh differently. Projects with the bake use schema 20.

Review affected clips in **Original clips and adaptations**. **Adapt clip** produces a rest-relative adaptation where the hierarchy and tracks are supported. Preview the adaptation before export or explicitly exclude that clip. Another change of base marks the adaptation stale. Export Original keeps the original FBX or GLB and clips available. Manual posing and clip or sweep previews leave the base unchanged until the bake command is used.

The bake requires normalized weights with at most four active influences per control point, a decomposable rig, and meshes without morph targets. Singular skin frames, newly collapsed triangles and unsupported rig attachments prevent the whole edit. Existing collapsed triangles may remain until repaired. The Kenney FBX used below has imported rest transforms outside the rig editor's supported profile. Geometry edits and export with its original clip still work.

### Integrated verification

Chrome ran the Release build with external requests blocked. Each workflow exported from the working project and again after reopening its `.assetfixer` archive offline. Unity 2022.3.62f2 and 6000.3.9f1 used the standard FBX importer. The independent readers were ufbx v0.23.0 and the project's Python GLB reader.

| Input and edit | Result |
| --- | --- |
| Shared-skin FBX with body and clothing, 20° Spine rotation | Both meshes share one three-bone skeleton. ufbx verified unchanged polygon order, corner UVs, raw weights and the expected new binds. The maximum position and adapted-clip error against the independent reference was `6.22e-8 m`. In both Unity versions, the adapted clip deformed both meshes with zero measured error across 21 samples per mesh. The browser verified Undo, Redo, saved-pose rebasing, the clip export guard and byte-identical original export. |
| Tripo `ceramic plate 3d model.zip`, Extrude → Auto Unwrap → UV Relax → Preserve Appearance | Extrude added three control points and six triangles at `0.2 mm` depth. ufbx verified the original control points and the expected polygon boundaries after UV layout triangulation. UV Relax moved 4,239 UV vertices and fixed 772. The bake wrote a `1024 × 1024` Base Color PNG with zero occupied texel misses. Geometry, UVs and PNG bytes matched after reopening. Both Unity versions imported 9,144 triangles and linked the Base Color PNG. |
| Authored Kenney animated FBX, move control point 100 | ufbx found exactly one moved control point with `+0.03125` source units on Y, unchanged connectivity, corner UVs and raw weights, and a maximum clip deformation error of `1.02e-6 m` versus the source. The reopened project matched the initial edited export across 21 regularly sampled poses and 17 extrema or endpoints. Both Unity versions imported 45 bones, 1,604 triangles and `Take 001`, with zero weight or deformation difference before and after reopening at 21 clip samples. |
| Tripo `man character 3d model.glb`, 15° Left Upper Arm rotation | The independent reader measured a maximum base-pose error of `5.18e-7 m` and a maximum rest-bind error of `1.03e-7 m`. All 67 joints, 17,623 triangles, UVs, indices, weights and embedded Base Color and Normal images were retained. Both GLB exports were byte-identical. This GLB has no authored clips. |

Run `node tools/base-pose-browser.mjs` from a built checkout with the E00 Chrome harness installed. The optional arguments are the Chrome executable, Tripo folder and Kenney FBX path. Generate the reference with `node tools/e00/shared-skin-fixture.mjs test-results/base-pose/shared-reference.fbx`. Build the [ufbx probe](../tools/e00/inspect_fbx.c) against the [pinned E00 corpus](E00_FBX_Round_Trip.md#fixtures), then run `python -B tools/base-pose-check.py --ufbx path/to/inspect_fbx.exe`. It writes `test-results/base-pose/independent.json`.

For Unity, place the reference and reopened shared-rig FBX in `Assets/BasePose/original` and `Assets/BasePose/exported`. Run [`SharedSkinProbe.RunBasePose`](../tools/e00/SharedSkinProbe.cs) and check `shared-skin-report.json`. For the plate and animated character, put the first export and reopened export under `Assets/Fixtures/<fixture>/original` and `Assets/Fixtures/<fixture>/exported`, keeping texture paths relative to their FBX. Run [`FbxProbe.Run`](../tools/e00/FbxProbe.cs) and check `e00-report.json`. The user-provided Tripo files and the Kenney corpus asset are local verification inputs. Their provenance is recorded in the [E00 fixture list](E00_FBX_Round_Trip.md#fixtures).

### Authored Mixamo clip on a rebased FBX

Three.js r180 credits Mixamo for the character and motion. The upstream `Samba Dancing.fbx` has SHA-256 `b9003ee562c87bf03051c3a502411b0808d3513f1d74a2011f7530d9f067069f`. The source and generated FBX files are kept in ignored local verification paths. [Three.js example](https://github.com/mrdoob/three.js/blob/r180/examples/webgl_loader_fbx.html#L13) · [Source FBX](https://github.com/mrdoob/three.js/blob/r180/examples/models/fbx/Samba%20Dancing.fbx)

AssetFixer baked a `+15°` local Z rotation of `mixamorig:LeftForeArm`, updating both `Alpha_Surface` and `Alpha_Joints` on the same rig. The skin has 52 weighted bones and 55,320 triangles across both meshes. The browser verified the clip export guard, adapted `mixamo.com` to `mixamo.com_Adapted_1`, saved and reopened the schema 20 project offline, then exported it. The authored clip retained its `18.2 s` range at `30 fps`. The source's `Take 001` contains no animated properties and is omitted by the exporter.

Both probes derive the expected mesh and bind shape from the source skin, then apply the rest-relative joint correction to the sampled source animation. They compare deformation of the rebased geometry against that reference. Unity uses the stock Generic model importer with mesh and animation compression disabled, imported normals and Standard four-influence skinning. It calculates the reference from Unity's imported source. ufbx uses the original FBX curves and sparse cluster weights directly.

| Probe | Skinning results | Maximum adapted deformation error |
| --- | --- | --- |
| ufbx v0.23.0 | Connectivity and raw cluster weights matched exactly across 27,850 control points. Base shape and bind matrices matched to numerical precision. | `0.255 mm` over 81 evenly spaced times. A separate run over all 547 source-frame times and 546 midpoints measured `0.163 mm`. |
| Unity 2022.3.62f2 and 6000.3.9f1 | All 35,389 imported vertices matched the expected base shape within `0.38 µm`. Weight error was zero for both meshes. | `0.068 mm` over 81 evenly spaced times in each Unity version. |

The first test exposed a `183 mm` deformation error between keys. Export now keeps Euler representations continuous across both equivalent ZYX branches. Import samples unweighted, time-independent auto-cubic FBX curves for the working animation, including source translation curves, and export retains the source frame rate when available. Other FBX tangent modes retain the existing import behavior. The output represents the supported authoring curves as sampled keys.

From a Release checkout with the E00 dependencies installed, save the upstream fixture as `test-results/authored-base-pose/Samba Dancing.fbx`. Run `node tools/authored-base-pose-browser.mjs`. Place the compiled ufbx probe in `test-results/authored-base-pose`, then run it as follows. Repeat without the final argument for the 81-sample run. [E00 probe build instructions](E00_FBX_Round_Trip.md#reproduce-on-windows)

```powershell
$folder = 'test-results/authored-base-pose'
& "$folder/inspect_fbx.exe" --authored-base-pose "$folder/Samba Dancing.fbx" "$folder/samba-reopened.fbx" 'mixamorig:LeftForeArm' 15 'mixamo.com' 'mixamo.com_Adapted_1' 1093
```

For Unity, copy [`FbxProbe.cs`](../tools/e00/FbxProbe.cs) and [`AuthoredBasePoseProbe.cs`](../tools/e00/AuthoredBasePoseProbe.cs) to `Assets/Editor`. Place the upstream FBX and the reopened export under `Assets/Fixtures/authored-base-pose/original` and `Assets/Fixtures/authored-base-pose/exported`. Run `AuthoredBasePoseProbe.Run` and check `authored-base-pose.json`.

### Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
npm.cmd run build:debug
node tools/e03-fixture.mjs
node tools/extrude-core.mjs
node tools/extrude-browser.mjs $chrome
python -B tools/extrude-verify.py 2022.3.62f2 6000.3.9f1
```

Compile the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows) and place `inspect_fbx.exe` under `test-results/extrude/` before running the Python verifier. The verifier builds Unity projects with independent reference shapes for `FbxProbe.Run` and checks positions, connectivity and UVs using ufbx. Generated FBX files and reports are under `test-results/extrude/`.
