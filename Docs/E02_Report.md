# E02 2D texture editor

## Workflow

Open **Texture editor** after loading an FBX or GLB. Select the object and material whose Base Color map you want to edit. Paint with Brush or Pixel Brush, or use Eyedropper to read the actual RGBA values. Use `Alt` + click to set the Clone Stamp source. **Aligned** retains the source offset between strokes. **Fixed** starts a new stroke from the selected source. Samples outside the image are skipped. A rectangular selection restricts writes and can be filled. The default color mode preserves alpha. **Edit alpha** makes the selected alpha value the brush channel.

The studio shows the map next to the model. A live preview uses a temporary texture binding and updates during the stroke. The viewport offers Fit, 100%, cursor-centered zoom, middle-button pan, **Focus UVs** and unlit 3D. UVs use the map's binding, affine transform and orientation. Lines are shown inside the image with separate weights for boundaries and internal edges. One map shared across bindings requires an explicit choice between editing it jointly and copying it for the selected binding. A bounded overlap probe reports shared UV coverage. The separate overlay and cursor stay out of the PNG. [Texture editing requirements](AssetFixer_Technical_Specification_v1.0.md#sec-12)

## Data and commands

Working color maps use straight RGBA8 in 32 × 32 tiles. An edit copies only touched tiles and commits once when the gesture completes. Both brush modes use one document history and the existing retention budget. Segments cover the continuous path and use maximum coverage per stroke to keep opacity independent of pointer event count. The soft 2D brush composites RGB in linear light and encodes the result as sRGB. Pixel Brush has hard edges and nearest texel sampling. Clone Stamp reads the immutable pre-stroke tile set. Lost pointer capture rolls back an unfinished stroke.

The editor supports local PNG, JPEG and WebP Base Color inputs at up to 4096 × 4096. The PNG path preserves straight 8-bit RGBA, including hidden RGB. JPEG and WebP use the browser's decoder. Export writes only the active map as lossless PNG at its working dimensions. FBX or GLB color replacement preserves the source sampling settings and unchanged maps. A new FBX atlas rebake samples the edited source color. The authored source archives retain their SHA-256 and undoing the last edit restores the prior image. Schema 3 adds working texture resources to `.assetfixer`; schemas 1 and 2 remain readable.

## Verification

| Check | Observed result |
| --- | --- |
| Brush, replacement and preview | PNG and JPEG replacements opened without rescaling. The brush covered the full fast-drag centerline. The model preview changed at a fixed camera. Half-opacity strokes with sparse and dense pointer samples produced the same PNG and matched linear-light RGB arithmetic. The oversized PNG control was refused. |
| Eyedropper, selection and alpha | The eyedropper returned hidden RGB with zero alpha. Rectangular fill changed the selected region and left adjacent texels unchanged. Unlocking alpha changed `(53, 0, 240, 0)` to `(53, 0, 240, 128)`. |
| Clone Stamp | All 19 texels in an overlapping gradient stroke matched their original source positions. A second aligned stroke retained its offset. Fixed mode returned to the initially chosen source. |
| Pixel zoom and overlay | The square Pixel Brush changed the same 36 texels at 50% and 400%, and their exported PNGs matched byte for byte. Turning the overlay off produced identical PNG bytes. |
| Shared and copied mappings | F07's three objects switched to the same edited image in shared mode. Copy mode edited only Tray. The other bindings kept their original image bytes. The independent parser matched the original F07 topology, corner attributes and bindings. The Khronos validator reported zero errors. The Meshy test preserved its two untouched embedded WebP maps when replacing Base Color with the edited PNG. |
| Shared history and project reload | The 2D and 3D atlas strokes changed the same map. Undo restored the previous 2D-only state, then the starting atlas. Redo and the offline `.assetfixer` reopen restored the exact combined PNG. The source FBX ZIP still matched its original SHA-256. |
| FBX round-trip | ufbx matched all eight control points, four triangles, original UVs and normals in both FBX exports. Unity 2022.3.62f2 and 6000.3.9f1 verified the raw UVs, both atlas UV channels, the assigned PNGs and the exact brush, stamp and alpha sample values. Both versions passed the inherited E01 animated shared-skeleton check. |

E02 covers Base Color and its alpha, rectangular masks, PAINT2D-01 through PAINT2D-04, PAINT2D-06 through PAINT2D-10, and the rectangular profile of PAINT2D-05. The tests exercise AT-03, AT-04, AT-05 and AT-06 for the implemented profile. Direct scalar maps, face and island masks, numerical UV edits, custom image color profiles, and the full E03 3D tools follow their respective stages. The UV visibility probe can miss overlaps smaller than its 256 × 256 sampling grid and omits repeated copies outside the displayed image. Atlas replacement requires the existing dimensions. [Stage assignments](AssetFixer_Technical_Specification_v1.0.md#sec-21)

## Reproduce on Windows

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd install --prefix test-results/e00-browser --save-exact playwright-core@1.65.1
npm.cmd run build
npm.cmd run build:debug
node tools/e01-browser.mjs $chrome
node tools/e02-browser.mjs $chrome
$version = '2022.3.62f2'
$project = python -B tools/e01-unity.py $version --textures
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'e02-unity.log'
$unityArgs = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'E02Probe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity E02 verification failed. See $log" }
```

The browser writes `mixed.assetfixer`, `atlas-2d-and-3d.png`, the FBX and GLB reference exports and `browser-report.json` in `test-results/e02/`. It uses the tracked F07, F15 and F17 fixtures and generates a gradient and size-limit control locally. For ufbx, extract `f15_source.zip` and the two FBX exports, then compare the raw export by default and the baked export with `--baked` and its corner map. Unity uses Generic rigs, imported normals, MikkTSpace tangents, standard skin weighting, full file scale, and disabled mesh and clip compression. The E02 texture import uses readable uncompressed maps with no mipmaps or rescaling. [Native reader setup](E00_FBX_Round_Trip.md#reproduce-on-windows)

Use `tools/e00/inspect_f17.mjs` on the tracked Meshy source and `meshy-webp-edit.glb` with `--base-color-png test-results/e02/meshy-base-color.png`. This compares the edited image payload, all original geometry accessors, texture sampling settings and both untouched WebP maps. [GLB reader setup](E00_F17.md#reproduce-on-windows)
