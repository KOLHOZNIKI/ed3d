# E04 Mesh Core

Mesh Edit selects authored vertices, edges and faces in the base pose. FBX control points keep their independent identity even when coincident and share nothing by position alone. GLB uses authored indices. UVs, normals and other corner attributes are kept separately from positions.

## Tools

| Tool | Workflow |
| --- | --- |
| Vertex, Edge, Face | Click the mesh or enter element IDs. Shift-click toggles a member of the selection. An edge ID uses its two vertex IDs. Select Connected expands across shared edges. |
| Move, Rotate, Scale | Drag the local-axis handles or enter values. Choose an axis and the selection-center or object-origin pivot. Preview and apply the edit as one history command. |
| Create Face | Select vertices in order, preview the triangulation and normal, and reverse winding when needed. Choose a material slot and optionally project UVs. Keep Last Edge starts the next contour with the opposite direction along the last selected pair. |
| Split Edge | Inserts one logical vertex into each incident polygon and subdivides the matching render triangles. Each side interpolates its own corner attributes. FBX source weights are interpolated before the preview reduces the influence count. |
| Split Face, Flip Edge, Dissolve | Split a polygon across two non-adjacent vertices. Flip the diagonal of compatible triangles or dissolve a compatible edge. |
| Weld | Preview a merge to the first selected point, the average, or groups within the selected tolerance. A weld keeps per-corner UVs and normal breaks. |
| Delete, Separate, Normals | Preview affected faces before deleting or separating them. Separate keeps materials and the original shared skeleton on bone-driven meshes. Flip Normals changes winding and Recalculate Normals respects explicit hard boundaries. |

The preview is revision-bound. Apply records one command in the same Undo/Redo history as painting. Schema 4 stores the ordered mesh edits and replays them over immutable originals when reopening. Versions 1–3 remain readable. The 3D paint mask includes created faces with usable UVs. A face created with placeholder coordinates carries a warning during editing and before export.

## Verification

| Case | Result |
| --- | --- |
| F01/F02 seam cube | Moving one control point by 31.25 mm moved its shared corners. The independent coincident point stayed put. Splitting the shared edge added one control point and two triangles. The two midpoint corners retained a 0.652519 UV gap and an 89.55° normal angle. Undo recovered the complete pre-split geometry and corner attributes. |
| Three open contours | A triangle, a quad and a six-sided polygon closed the three fixture openings. ufbx retained the polygon sizes. Unity imported 33 triangles. The browser also verified winding reversal, rejection of a crossing contour, Split Face, Flip Edge, Dissolve, normal edits, and Delete with Undo. |
| Animated two-bone elbow | Split Edge produced a midpoint with weights 0.75 Base and 0.25 Elbow. The four-to-six triangle edit preserved previous weights and the one-second clip. After Separate, both renderers still referenced the same bones. Unity measured zero pose difference for old vertices and separated parts across 21 samples. ufbx independently checked the source weights, shared bones and clip deformation. |
| Tripo GLB | The numeric move changed only vertex 100 and recalculated four normal tuples nearby. Indices, UVs, all 67 joints, weights, both texture payloads, and the compatible polygon marker remained intact. The glTF validator reported zero export errors. |
| GLB with color and a morph | The independent reader verified a new shared midpoint with color (0.5, 0, 0.5), UV (0.5, 0.5), and morph displacement (0, 0, 0.25). All existing tuples and the named morph were retained. |
| Project and surface editing | The browser saved and reopened the separated object, its visibility and the edit sequence. The New Faces paint mask listed only the two created faces with valid UVs. |

The browser also tested dragging the X gizmo handle, cancelling a preview with Esc and applying a rotation with Enter. The tests used Chrome 158.0.8127.37 with external requests blocked, Unity 2022.3.62f2 and 6000.3.9f1, and ufbx 0.23.0. The seam cube is a checked-in project fixture. Repository scripts generate the elbow, the contours and the colored GLB. The Tripo character is a local file.

## Limits

- Mesh edits use the base pose. Editing a project with an active generated atlas requires removing that atlas first. E06 covers UV editing and appearance-preserving transfer to new layouts.
- Face creation rejects self-intersections, repeated vertices, non-manifold edges and excessive non-planarity. Projecting UVs into 0–1 can reuse existing texels. Packing and resolving overlaps remain UV operations.
- Flip Edge and Dissolve require compatible materials and matching corner attributes along the shared edge. Delete and Separate keep at least one face in the original object.
- GLB exports triangle indices and may use separate render indices for corner attributes. Edits that invalidate private polygon metadata report its omission. A GLB split or weld that needs more than four weights is refused. The supported FBX profile retains the full source skin weights, while preview uses the four strongest.
- The FBX writer still blocks morph targets. Separate disallows meshes with animation tracks on the mesh node itself. Bone-driven animation and shared skeletons are preserved.

## Reproduce

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$tripo = 'D:/downloads/Tripo'
npm.cmd run build
npm.cmd run build:debug
node tools/e03-fixture.mjs
node tools/e04-fixture.mjs
node tools/e04-browser.mjs $chrome $tripo
python -B tools/e04-inspect-glb.py (Join-Path $tripo 'man character 3d model.glb') test-results/e04/tripo-mesh-edited.glb
python -B tools/e04-inspect-glb.py --morph test-results/e04/colored-morph.glb test-results/e04/colored-morph-split.glb
node tools/e00/validate-glb.mjs (Join-Path $tripo 'man character 3d model.glb') test-results/e04/tripo-mesh-edited.glb
$project = python -B tools/e04-unity.py 2022.3.62f2
```

Run the assembled project in Unity batch mode with `-executeMethod E04Probe.Run`. Compile the [ufbx inspector](E00_FBX_Round_Trip.md#reproduce-on-windows) and use `--e04` with the FBX files from the project's fixture directories in this order **seams-e04-source**, **seams-e04-moved**, **seams-e04-split**, **seams-e04-undo**, **holes-filled**, **skin-source**, **skin-split**, **skin-separated**. The browser and Unity reports are under `test-results/e04`.

The next stage is E05 Basic Repair. [Technical specification](AssetFixer_Technical_Specification_v1.0.md#sec-21)
