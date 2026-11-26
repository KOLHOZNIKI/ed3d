# E00 F01/F02 topology seam check

The [source fixture](../tools/e00/fixtures/topology_seams.zip) is a project-owned binary FBX and a 64 × 64 checker PNG under the [repository license](../LICENSE). It combines F01 and F02 for the [§7.7 compatibility gate](AssetFixer_Technical_Specification_v1.0.md#sec-07). One mesh contains a triangulated cube and an independent triangle. The cube has a separate UV chart and an explicit flat normal on each side. Control point 0 is shared by six triangle corners across three sides. Control point 8 is at the same position and has the same UV and normal as one of those sides. Only the detached triangle uses point 8.

The browser exports the original through the normal **Export FBX ZIP** button. The edit probe calls the existing E00 position adapter to move control point 0 by +0.03125 m along Y. It keeps the authored corner attributes. Both outputs reopen in Chrome with 13 triangles. The two packages preserve the exact checker PNG bytes.

| Source entry | SHA-256 |
| --- | --- |
| `topology_seams.zip` | `76066edaa3dcbcb39e9dc08f1f80317bc305863ee689d0cc831d58d23674e8bc` |
| `topology_seams.fbx` | `bdd898337dac2f502092d6bcf87dfc7f1c67c8d4e112a5199ce9b706c6d86b18` |
| `topology_seams.fbm/Checker.png` | `a3b88ee001c35b22dec49e482abbafee5bdc1f6babc0fd6ea56e9198d5150460` |

## Results

ufbx 0.23.0 compared the control points and checked all 39 polygon corners in FBX order. The no-op retained all 11 control points and 13 triangle boundaries. The edited FBX retained the same boundaries and moved exactly one control point by 31.25 mm. Point 8 moved 0 mm. Both exports retained the three distinct UVs at point 0 and the 90° angle between its face normals. The minimum UV gap was 0.537645 UV units. The largest corner UV and normal changes were zero.

Unity 2022.3.62f2 and 6000.3.9f1 imported 27 vertices and the bound checker map in all three files. Each version moved all three imported copies of the cube point by 31.25 mm and kept the independent triangle's vertex stationary. The maximum position error against the expected edit was 0 m. Corner UV differences and normal angle differences were also zero. The three normals remained 90° apart.

The Unity probe uses the detached triangle's corner below the cube to locate its coincident vertex. It matches all 13 triangles with their expected winding and per-corner positions, UVs and normals. Import used Generic rig, imported normals, calculated MikkTSpace tangents, and disabled compression, mesh optimization and vertex welding for this fixture. ufbx checks the underlying FBX control-point IDs. Unity checks the imported mesh and the bound checker material.

Both probes reject the unchanged export when given the edit expectation. This verifies that a lost edit cannot pass the geometry check.

## Reproduce on Windows

Use a pinned Playwright and ufbx install as described in the [FBX round-trip report](E00_FBX_Round_Trip.md#reproduce-on-windows). The fixture, browser check and Unity project setup use local files and can run without Tripo inputs. [Generator](../tools/e00/seam-fixture.mjs) · [Edit expectation](../tools/e00/topology-seams.json)

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd install --prefix test-results/e00-browser --save-exact playwright-core@1.65.1
node tools/e00/browser.mjs --seams $chrome
$version = '2022.3.62f2' # Repeat with 6000.3.9f1.
$project = python tools/e00/fixtures.py --seams $version
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'topology-seams-unity.log'
$argsForUnity = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'SeamTopologyProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $argsForUnity -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity probe failed. See $log" }
Get-Content (Join-Path $project 'topology-seams-report.json')
```

Build the native inspector as in the [FBX round-trip report](E00_FBX_Round_Trip.md#reproduce-on-windows) and run it against both exported files.

```powershell
$fixtures = Join-Path $project 'Assets/Fixtures'
$source = Join-Path $fixtures 'seams-baseline/original/topology_seams.fbx'
$noEdit = Join-Path $fixtures 'seams-baseline/exported/topology_seams_e00.fbx'
$edited = Join-Path $fixtures 'seams-edited/exported/topology_seams_e00_edited.fbx'
$inspect = 'test-results/e00/ufbx/inspect_fbx.exe'
& $inspect $source $noEdit --seams 0
if ($LASTEXITCODE -ne 0) { throw 'The unchanged export failed.' }
& $inspect $source $edited --seams 0.03125
if ($LASTEXITCODE -ne 0) { throw 'The edited export failed.' }
& $inspect $source $noEdit --seams 0.03125
if ($LASTEXITCODE -ne 1) { throw 'The missing edit control should fail.' }
```

The reference packages are `topology_seams_e00.zip` and `topology_seams_e00_edited.zip` in `test-results/e00/exports/`. Run `node tools/e00/seam-fixture.mjs` to regenerate the source ZIP byte for byte and write the standalone FBX and its linked map in `test-results/e00/seam-fixture/`.
