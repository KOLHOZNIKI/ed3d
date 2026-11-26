# E00 directional normal map on rotated and mirrored UVs

F14 uses a project-generated folded mesh with two connected quads and a 256 × 256 tangent-space normal PNG. The PNG contains four asymmetric directional swatches with nonzero tangent and bitangent components. The reconstructed source normal tilts by up to 42.6° from its geometric normal. The [fixture generator](../tools/e00/normal-fixture.mjs) is licensed with the repository.

The browser loads the FBX ZIP, generates two xatlas charts, bakes Base Color and Normal at 1720 × 2192, exports a new FBX ZIP and reopens it. The baker converts the source normal through the surface into the target tangent basis and includes both MikkTSpace handedness signs. The baked FBX uses the atlas as UV0 and keeps the original coordinates in UV1. The verified tangent rotation and sign change are relative to those two UV layouts, as measured from the actual Unity imports. [MikkTSpace handedness](https://github.com/mmikk/MikkTSpace/blob/master/mikktspace.h), [Unity MikkTSpace tangent import](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/ModelImporterTangents.CalculateMikk.html)

## Unity results

The probe uses imported mesh normals, Unity's calculated MikkTSpace tangents and an uncompressed Normal Map with mipmaps, trilinear filtering and green-channel inversion disabled. A diagnostic shader reconstructs world-space unit normals from the imported maps. The probe measures angles from a 640 × 640 floating-point render target. It uses a six-screen-pixel guard selected from the source image around each sample, excluding silhouettes, the fold seam and texture transitions.

| Panel | Tangent rotation | Handedness before → after | Interior samples per Unity version | Maximum angular error | Mean angular error |
| --- | ---: | --- | ---: | ---: | ---: |
| Rotation only | 37° | +1 → +1 | 69,823 | 0.517° | 0.312° |
| Rotation and reflection | 23° | −1 → +1 | 34,308 | 0.257° | 0.188° |

Unity 2022.3.62f2 and 6000.3.9f1 passed the 2° limit from §22.2 on both panels. The shader also measured each normal's Lambertian response under two directional lights with opposing vertical directions. All 88,926 samples with a source light preference greater than 0.05 retained that preference. The maximum change in the normalized light response was 0.00782 on the rotated panel and 0.00261 on the mirrored panel.

The negative control sampled the original map at the original UVs while using the exported tangents. This simulates a transfer of the RGB values without a change of basis. Its maximum angular errors were 24.81° on the rotated panel and 78.96° on the mirrored panel. The preferred light reversed on all 34,308 measured samples on the mirrored panel. The original and baked renders and the negative control are saved under the generated Unity project's `captures/` directory for both light directions.

ufbx independently matched all six control-point positions, original per-corner UVs and geometric normals and verified all four atlas triangles. The probe covers rotated and mirrored mesh UV coordinates on an unchanged surface. Texture-node transforms on normal maps, edited surfaces and other importer compression settings remain separate cases.

## Reproduce on Windows

Use the Chrome, Unity and Playwright setup from the [texture rebake report](E00_Texture_Rebake.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
node tools/e00/normal-fixture.mjs
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --normal
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --normal
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'normal-unity.log'
$unityArgs = @('-batchmode', '-force-d3d11', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'NormalBakeProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity normal probe failed. See $log" }
Get-Content (Join-Path $project 'normal-report.json')
```

The generated input is `test-results/e00/normal-fixture/directional_normals.zip`. The observed SHA-256 for this run was `4c0b052f419d058f1d55a252e3ce1699326246ab71ad53cdd06fa7fb94b44807`. The browser writes `test-results/e00/exports/directional_normals_e00_baked.zip`. The native check uses `inspect_fbx --baked` with the exported `uv-atlas-source-corners.bin`, as in the texture rebake report.
