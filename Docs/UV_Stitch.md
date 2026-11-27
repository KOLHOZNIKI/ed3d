# UV edge stitch

**Stitch UV edge** implements UV-12 from [the UV Editor specification](AssetFixer_Technical_Specification_v1.0.md#sec-11). It joins the two UV sides of a shared mesh edge on the current channel and keeps the picked side fixed.

1. In **UV Editor**, choose **Edge** and **Stitch UV edge**.
2. Select the edge on the side that should stay fixed. Click **Update draft**.
3. Inspect the joined edge and UV diagnostics. **Cancel draft** discards the preview.
4. Use **Change Mapping** to apply the new coordinates with the current images, or **Preserve Appearance** to rebake from the current working snapshot. The applied result enters the existing Undo and Redo history.

The tool matches endpoints by logical mesh vertex identity. Moving a UV endpoint also moves its continuously connected UV occurrences. Other seams are retained, including those with endpoints that happen to align after the edit. Geometry positions, weights and polygon connectivity are retained. A supported edge joins two distinct mesh faces with opposite edge winding and the same material slot. The draft is refused if an edited triangle would collapse, flip or overlap another UV triangle, or if an endpoint group would need to move across a different material binding. Each operation handles one edge. GLB inputs with separately indexed coincident positions require an authored shared mesh edge for stitching.

## Verification

The fixtures are generated locally by the repository test under the project license. The FBX mesh has four triangles, a hard normal seam and an independent triangle with one coincident control point. The skinned variant has two bones and one authored clip. The GLB fixture exercises a seam created in the editor on an indexed shared edge.

| Check | Result |
| --- | --- |
| Core and Chrome | Picking either side fixed the corresponding anchor. The core check rejected open boundaries, different materials, overlapping UVs and flipped UVs. Chrome verified draft cancellation, Undo and Redo, saved project replay, FBX reimport and byte-identical source maps in Change Mapping. |
| FBX in ufbx v0.23.0 | Each export changed exactly three UV corner occurrences. All eight control points, polygon boundaries, corner normals and original skin weights were retained. Animated deformation matched within 0.034 µm at 21 samples. |
| FBX in Unity 2022.3.62f2 and 6000.3.9f1 | Generic import retained both expected UV endpoints, base positions, normal seams and one Base Color binding per file. The animated fixture preserved both bones and all weights. Maximum sampled deformation difference was 0.246 µm across 21 samples. |
| Preserve Appearance | The 256 × 256 bake sampled the expected source gradient on the moved face and reported zero unresolved occupied texels. |
| GLB | Mark, move and stitch restored the shared layout. The independent reader matched all six ordered position, normal and UV corner tuples. Khronos glTF Validator reported zero errors and warnings. |

Unity imported the source normals, calculated MikkTSpace tangents, and used standard skin weights. Mesh and animation compression and mesh optimization were disabled.

## Reproduction

Use the pinned Playwright browser and ufbx setup from [the FBX baseline](E00_FBX_Round_Trip.md#reproduce-on-windows).

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/uv-stitch-core.mjs
node tools/uv-stitch-browser.mjs
node tools/e00/validate-glb.mjs test-results/uv-stitch/connected.glb test-results/uv-stitch/connected-restored.glb
python tools/uv-stitch-unity.py 2022.3.62f2 6000.3.9f1
```

Compile the updated `tools/e00/inspect_fbx.c` with ufbx and pass the source and stitched FBX paths followed by `--uv-stitch`. Run the Unity projects with `-batchmode -nographics -quit -executeMethod FbxProbe.Run`, then repeat the Unity setup command with `--verify`. The generated FBX, GLB and project files, browser results, Unity logs and JSON reports are under `test-results/uv-stitch/`.
