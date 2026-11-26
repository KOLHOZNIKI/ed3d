# E00 Smooth Fill and Grid Fill

Both probes start from the same Tripo ceramic plate. They replace four quads incident to control point 1872 on the bowl surface. The quads define a four-sided cavity with two edges on each side. Its eight boundary vertices already belong to the surrounding mesh. The center has two distinct authored UV coordinates at the source seam.

- **Smooth Fill** constructs an eight-triangle fan and solves the uniform Laplacian equation for the single interior vertex with the eight boundary vertices pinned.
- **Grid Fill** reconstructs four quads in a 2 × 2 grid. It places the interior vertex at the center of a bilinearly blended Coons patch, using all four side midpoints and corner positions. [Discrete Coons patch construction](https://web.cs.ucdavis.edu/~hamann/HamannJean1996.pdf)

The fill checks for one oriented boundary loop, exactly one adjacent exterior face at each boundary edge, and a non-overlapping fan in the patch projection. Grid also requires convex projected cells. The replacement uses the original control-point IDs and a source corner for every exported corner. Original per-corner UVs, normals and material assignments follow those references. The source mesh stays available as the unedited snapshot. New-hole UV generation and a general contour selection tool are outside this E00 probe.

## Results

Chrome generated both variants through the FBX ZIP export path and opened the resulting ZIPs. The ZIPs carry the same source Base Color image bytes. The source Tripo archive hash matches the value in the [FBX round-trip report](E00_FBX_Round_Trip.md#fixtures).

| Method | Center movement | Replacement faces in FBX | Triangles in the imported Unity mesh |
| --- | ---: | --- | ---: |
| Smooth Fill | 1.865 mm | 8 triangles | 9,138 |
| Grid Fill | 1.569 mm | 4 quads | 9,138 |

Unity 2022.3.62f2 and 6000.3.9f1 found the same repaired center positions as expected, with zero measured position error. Each patch shared all eight boundary edges with its surroundings. The 9,130 triangles outside the repair matched the source in connectivity, positions, winding and UVs. All replacement UV corners matched their authored UVs exactly, including both UV coordinates at the moved center. Base Color was linked on both exports.

ufbx independently reconstructed each expected patch from the source FBX quads, checked every output polygon against that construction, and recomputed the interior position from the original boundary vertices. All 4,577 control-point IDs remained in place. Every position outside the center and every exported corner UV matched exactly. The largest serialized corner normal angle was within floating-point precision.

## Reproduce on Windows

Use the local Tripo fixtures, browser harness dependencies, and ufbx checkout from the [FBX round-trip report](E00_FBX_Round_Trip.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --repair
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --repair
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'repair-unity.log'
$unityArgs = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'RepairProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity repair probe failed. See $log" }
Get-Content (Join-Path $project 'repair-report.json')
```

The browser writes `ceramic_plate_3d_model_e00_smooth.zip` and `ceramic_plate_3d_model_e00_grid.zip` under `test-results/e00/exports`. Each ZIP has a provenance map with one little-endian 32-bit source polygon corner index per output corner. Build the native reader as described in the FBX round-trip report.

```powershell
foreach ($method in @('smooth', 'grid')) {
  $case = Join-Path $project "Assets/Fixtures/$method"
  $source = (Get-ChildItem (Join-Path $case 'original') -Filter '*.fbx').FullName
  $exported = (Get-ChildItem (Join-Path $case 'exported') -Filter '*.fbx').FullName
  & 'test-results/e00/ufbx/inspect_fbx.exe' $source $exported "--$method" 1872
  if ($LASTEXITCODE -ne 0) { throw "ufbx check failed for $method" }
}
```
