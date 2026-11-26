# E00 xatlas probe

The prototype uses `xatlas-wasm@0.1.3` in a local Web Worker. It unwraps the same indexed control-point triangles that the FBX loader uses for preview. The probe requests a target resolution of 1024 and four texels of padding. xatlas chooses the packing dimensions. [xatlas source](https://github.com/jpcy/xatlas) and [WebAssembly wrapper API](https://github.com/mode777/xatlas-wasm/blob/main/API.md)

The loader tracks the original FBX polygon corner behind each triangle corner. The probe checks that every xatlas index resolves to the same control point through `xref`. A render vertex is shared only when its xatlas vertex and all original render attributes match. The probe checks every remapped corner component by component, including position, normal, joint indices, weights, and UV0.

**Generate UV atlas** creates a separate snapshot. **Discard UV atlas** restores the source snapshot. The atlas FBX writes triangles with the original control point IDs, raw skin clusters, and original corner attributes. This lets UV1 charts split along a diagonal of an original quad. The source UV0 continues to drive existing textures. The ZIP contains `uv-atlas-source-corners.bin`, a little-endian unsigned 32-bit index into the source polygon corner array for each exported triangle corner.

## Results

The production build opened the two local Tripo ZIPs, generated UV1, exported each FBX ZIP, and reopened both exports in Chrome. The browser made zero external requests.

| Tripo fixture | Triangles | Control points | UV charts | Atlas dimensions | Control points split by xatlas | Render vertices after remap |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Ceramic plate | 9,138 | 4,577 | 44 | 1163 × 1171 | 368 | 6,353 |
| Skinned character | 17,623 | 8,829 | 492 | 1253 × 1269 | 3,383 | 19,406 |

ufbx v0.23.0 verified original control-point positions and UV0 exactly. The corner map accounted for every triangle and the boundary of every original polygon. The maximum corner normal angle was `1.21e-6°` on both files. Every exported triangle had nonzero UV1 area and coordinates within `[0, 1]`. The character retained all 67 bone clusters and their original control-point indices and weights exactly.

Unity 2022.3.62f2 and 6000.3.9f1 imported UV1 for all 6,358 plate vertices and all 19,407 character vertices. The source meshes had 6,067 and 17,425 vertices, respectively. Imported positions and UV0 matched exactly. Seven character normals differed by more than `1e-5` in vector length after Unity import. The largest difference was `6.97e-4` (about `0.04°`). The independent FBX reader measured agreement within floating-point precision. The maximum Unity bone weight difference was zero. The character retained 67 bones and a valid Humanoid Avatar. The maximum world-space deformation difference over three forearm rotations was `5.57e-7 m`.

This probe supports a single unedited FBX mesh that has one authored UV set and can be exported via the existing E00 path. The new channel is available for the later texture rebake. Multi-mesh atlases, mesh edits before unwrapping, morph targets, and GLB unwrapping require separate coverage.

## Reproduce on Windows

Use the local Tripo fixtures and tooling described in the [FBX round-trip report](E00_FBX_Round_Trip.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --unwrap
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --unwrap
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'e00.log'
$unityArgs = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'FbxProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
Get-Content (Join-Path $project 'e00-report.json')
```

Build `inspect_fbx.exe` as in the FBX round-trip report. It exits with a nonzero code if the corner correspondence, positions, normals, original UVs, atlas UV coverage, or skin clusters fail the check.

```powershell
foreach ($case in Get-ChildItem (Join-Path $project 'Assets/Fixtures') -Directory -Filter '*-atlas') {
  $source = (Get-ChildItem (Join-Path $case.FullName 'original') -Filter '*.fbx').FullName
  $exported = (Get-ChildItem (Join-Path $case.FullName 'exported') -Filter '*.fbx').FullName
  $map = Join-Path $case.FullName 'uv-atlas-source-corners.bin'
  & 'test-results/e00/ufbx/inspect_fbx.exe' $source $exported --atlas $map
  if ($LASTEXITCODE -ne 0) { throw "ufbx check failed for $($case.Name)" }
}
```
