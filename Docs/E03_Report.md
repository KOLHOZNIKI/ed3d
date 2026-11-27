# E03 3D Paint

AssetFixer V0.1 adds 3D Base Color editing for FBX ZIP and GLB. It uses the same image, tiled history, project save, checkpoint, and export paths as the 2D editor. A stroke commits on pointer release and can be cancelled while the worker prepares its coverage. The viewport displays the footprint for the current pointer position.

## Behavior

| Control | Behavior |
| --- | --- |
| Surface | The default brush measures diameter in scene units. It unfolds adjacent triangles about authored edges and checks that paths cross those edges in order. |
| Screen projection | Applies a viewport-pixel footprint to eligible visible surfaces of the current binding. |
| Texture pixels | Snaps the footprint to the image grid. A one-texel brush changes one eligible texel per dab. |
| Base Color binding | 2D and 3D use the same selected material binding. Shared images require confirmation and stay editable through the 2D editor. |
| Selected faces and UV islands | Clicking in mask-picking mode toggles source faces or UV islands. The current 2D rectangle also limits writes. |
| Frozen pose | Chooses a clip and time for display and brush picking. Stroke sampling uses the morphed and skinned vertex positions. Export uses the original asset transforms. |
| Create paint atlas | Unwraps a single FBX mesh with no UVs and creates a blank Base Color map for an eligible material. |

Front-facing geometry must pass a depth test against visible scene meshes. Transparent and alpha-cutout materials use the same geometric hit rule, including where alpha samples are transparent. Brush writes preserve image alpha. Surface and Screen projection carry Base Color up to the export atlas padding distance, or two texels for a source map. The nearest covered texel owns its gutter, and masks and Texture pixels mode limit writes to the footprint.

## Verification

| Case | Evidence |
| --- | --- |
| Tripo ceramic plate | The brush changed 287,405 covered texels across two UV seams. Unity 2022.3.62f2 measured zero gaps across 1,168 centerline samples, 323 seam samples and 4,842 side-lane samples. All 310,242 underside pixels matched the base bake. ufbx matched 4,577 control-point positions, the original corner UVs and all 9,138 mapped atlas triangles. The maximum corner normal angle was 0.0000013°. |
| Connected lobes and an occluded plane | The surface brush changed 482 left-lobe texels, zero right-lobe texels and zero on the occluded plane. Screen projection reached both visible lobes, with 562 and 230 changes respectively, and kept the occluded plane intact. The faces share a path through the bridge at the top. |
| Face and island masks | A face mask restricted the screen stroke to 226 eligible texels on the chosen face. The island mask and the one-texel mode wrote exactly one texel. Undo recovered the baseline. The exported texture matched after reopening and during a forced WebGL context loss. |
| Disconnected panels | F15 reported 53,942 changed texels on the target panel and zero on the nearby panel. The unrestricted control changed 45,698 texels on the nearby panel. |
| Frozen elbow | At 0.25 s the cursor covered 593 viewport pixels at a location outside the rest pose. The stroke changed 181 texture texels. The 2D PNG matched the FBX-linked PNG byte for byte. Unity and ufbx both verified the two-bone rig and the one-second clip over 21 samples with zero export deformation delta. ufbx also verified unchanged source weights, connectivity, normals and UVs. |
| UV handling | A shared-UV fixture displayed the overlap warning. The no-UV FBX created a paintable atlas, exported the linked PNG and recovered it through the project file. |
| Tripo man character GLB | The export embedded the working Base Color PNG and retained the original Normal texture. The independent glTF parser checked indices, positions, normals, UVs, joints and weights. Khronos glTF Validator reported zero export errors. |

The browser tests used Chrome 158.0.8127.37 and a local server with external requests blocked. Unity rendered the plate using the RTX 3070 with the original diagnostic shader and mipmap settings. The generated lobe, overlap, and elbow fixtures are authored in the repository's E03 fixture script. Tripo files are local user fixtures.

## Limits

- Surface unfolding tests up to four paths per triangle. Complex junctions and highly curved or non-manifold geometry can reduce the footprint. Triangles crossing the camera plane are skipped.
- FBX adjacency uses authored control points. GLB adjacency uses authored primitive indices. A seam whose GLB vertices are stored as independent indices has separate brush footprints on each side. A drag can paint both sides.
- Transformed UVs within the image are supported. Bindings that sample beyond the 0–1 UV range are blocked and report that repeat or mirror copies would be ambiguous.
- The overlap warning uses a 256 × 256 coverage probe. Small overlaps can escape this test. Where surfaces share texels, edits remain visible through all of those surfaces.
- The generated atlas path covers a single FBX without source UVs and with an opaque material and at most a Base Color map. To paint a GLB without UVs, unwrap the source and reimport it. FBX preview remains approximate above four skin influences and FBX morph export is blocked by the existing adapter.

## Reproduce

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
npm.cmd run build:debug
node tools/e03-fixture.mjs
node tools/e03-browser.mjs $chrome $tripo
node tools/e02-browser.mjs $chrome
node tools/e00/f15-browser.mjs $chrome
python -B tools/e00/inspect_glb.py (Join-Path $tripo 'man character 3d model.glb') test-results/e03/tripo-painted.glb --base-color-edit test-results/e03/tripo-painted.png
node tools/e00/validate-glb.mjs (Join-Path $tripo 'man character 3d model.glb') test-results/e03/tripo-painted.glb
```

The [plate procedure](E00_3D_Brush.md#reproduce-on-windows) runs the production brush against the original seam and underside probe. For the elbow, run `python -B tools/e03-unity.py 2022.3.62f2` and run Unity in batch mode with `-executeMethod FbxProbe.Run`. The assembled `Assets/Fixtures/bent-elbow` directories also contain the input and exported FBX files for the ufbx comparator. Reports are under `test-results/e03` and `test-results/e00`.

The next stage is E04 Mesh Core. [Technical specification](AssetFixer_Technical_Specification_v1.0.md#sec-21)
