# V1+ scope and verification

The specification lists the following extensions after mandatory V1. The order in the repair list comes from [§9.2](AssetFixer_Technical_Specification_v1.0.md#92-proposed-additional-repair-tools).

| Extension | Status |
| --- | --- |
| Soft Selection with adjustable radius and falloff | Verified below |
| Smooth Selection with fixed boundaries | [Verified](#smooth-selection) |
| Flatten Selection to a selected or averaged plane | Planned |
| Simple Extrude for a boundary or region | Planned |
| Subdivide a selection with compatible adjacent faces | Planned |
| Mirrored movement with a matching tolerance | Planned |
| UV Stitch / Weld (UV-12) | [Single-edge workflow verified](UV_Stitch.md) |
| UV Relax (UV-16) with fixed boundaries and advanced pin constraints | Planned |
| Make the current pose the new base pose | Planned geometry and animation baking |

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
