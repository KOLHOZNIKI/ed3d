# E00 3D brush across UV seams

This report records the original E00 prototype. The current application uses [E03 3D Paint](E03_Report.md). The reproduction below uses its surface brush with a diameter chosen for the Unity probe's original stroke lanes.

The static Tripo ceramic plate uses the 2396 × 2396 atlas from the [texture rebake probe](E00_Texture_Rebake.md). Turn on **3D brush (visible projection)** after rebaking, choose a Base Color, and drag on the surface. This mode projects a 24-viewport-pixel brush onto camera-visible triangles. It applies the stroke at pointer release. **Undo** restores the previous PNG snapshot byte for byte.

The worker rasterizes the stroke as a continuous polyline in screen space. The first visible triangle hit by the stroke center locks the stroke to its edge-connected component in the source FBX. For each atlas texel in that component, the worker projects the corresponding point, tests the brush mask, and checks front-facing orientation and occlusion against nearby projected triangles. Adjacent triangles on different UV islands sample the same stroke. Painted texels extend into the baked gutter up to sixteen texels. The working PNG owns the result used by the preview and the ZIP exporter. The baked layout stays in the first FBX UV channel for Unity. The original UVs remain in the second channel. [F15 component isolation](E00_F15.md#brush)

The browser probe uses ray intersections to discover two new UV seams under the stroke. Both seams follow shared control-point edges that were continuous in the original UVs. It verifies the undo PNG against the original bake, redraws the stroke through pointer events, exports the painted FBX ZIP and reopens it. [Three.js raycaster](https://threejs.org/docs/pages/Raycaster)

The Unity probe imports the painted FBX, follows its linked Base Color map and renders at 768 × 768 with mipmaps and trilinear filtering. It maps the browser's surface samples to the imported triangles by their atlas UVs. The comparison samples the centerline and four parallel lanes. It also renders the unpainted rebake and the painted plate from underneath and compares their pixels.

## Results

The turquoise stroke changed 277,303 covered atlas texels. The browser reproduced it after undo restored the baseline PNG. The source Tripo archive's SHA-256 matched the recorded input hash.

| Check | Unity 2022.3.62f2 and 6000.3.9f1 |
| --- | --- |
| Stroke centerline | 1,168 samples with zero gaps |
| Both new seams | 323 samples within the two crossing regions, with zero gaps and full measured brush coverage |
| Four parallel lanes | 4,842 samples with zero gaps. Four samples at two pixels away from the seams mixed brush and base color under mip filtering. The minimum brush contribution there was 40.5%. |
| Underside | All 310,242 visible pixels matched the unpainted rebake |

ufbx matched the painted export against the unpainted rebake. All 4,577 control-point positions, 9,138 triangles, both UV channels and the corner normals matched exactly.

This prototype covers visible projection painting on a static, opaque, single-material FBX after the E00 rebake. Geodesic brush footprints within a connected surface, skinned painting, 2D paint history, and interactive brush preview remain later work.

## Reproduce on Windows

Use the local Tripo fixtures and Chrome and Unity setup from the [texture rebake report](E00_Texture_Rebake.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --paint
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --paint
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'paint-unity.log'
$unityArgs = @('-batchmode', '-force-d3d11', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'PaintProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity brush probe failed. See $log" }
Get-Content (Join-Path $project 'paint-report.json')
```

The browser writes `ceramic_plate_3d_model_e00_painted.zip` under `test-results/e00/exports`. The Unity project's `captures/` directory contains the before, painted, and underside views. The painted FBX can also be checked with `inspect_fbx --baked` and the exported corner map as in the texture rebake report.
