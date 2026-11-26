# E00 FBX and ZIP round-trip

The browser prototype accepts one binary FBX with external PNG or JPEG maps, either as separate files or in a ZIP. The export contains a reconstructed FBX, its linked maps in a `.fbm` folder, and a `manifest.json`. Source images that the adapter could not bind are stored in `unassigned/`. The model and textures are processed locally.

## Results

Chrome opened each fixture, downloaded its FBX ZIP, and reopened the ZIP with the same triangle, bone, and clip counts. It also opened the loose static FBX with its companion image, reported the missing image when the FBX was opened alone, rejected a ZIP path outside the virtual folder, and rejected a Z-up Tripo asset outside the current profile. No external requests were observed from the browser page.

| Fixture | Unity 2022.3.62f2 and 6000.3.9f1 | Independent read with ufbx v0.23.0 |
| --- | --- | --- |
| Static ceramic plate | 9,138 triangles, identical sampled base positions and bounds, one Base Color map linked. | 4,577 control points, 5,134 polygons and 19,406 corners. Exact polygon connectivity, positions and corner UVs. |
| Skinned Tripo character | 17,623 triangles, 67 bones and bind matrices, identical sampled base positions and weights, valid Humanoid Avatar before and after export. Both Base Color and Normal were linked. Maximum world-space delta was `4.95e-7 m` at rest and `5.57e-7 m` across three rotations of `Left_LowerArm`. The source contains no clips. | 8,829 control points, 9,287 polygons and 36,197 corners. Exact polygon connectivity, positions, corner UVs and original skin indices and weights. |
| Synthetic skinned ribbon | Two bones and one one-second clip. No measured deformation difference at 21 samples, including the keyed extrema at 0.25 s and 0.75 s. | Six control points and four polygons with exact connectivity. One animation stack. |

The ufbx check compares polygon boundaries and the control point index at every corner. Axes and units matched for all three fixtures. The maximum corner normal difference on either Tripo fixture was about `1.21e-6°`. The exported ZIPs retain all source JPEG bytes. The character's Roughness and Metallic maps are included in `unassigned/` and require manual assignment.

Unity's comparison used Generic rigs, imported normals, calculated MikkTSpace tangents, four skin influences, file scale, and disabled mesh compression, animation compression, mesh optimization, and axis baking. Humanoid Avatar validity was checked separately on the real character. The Unity position probe matches vertices by their coordinates in world space.

## Position edit round-trip

The browser probe moved one control point on a UV seam in each Tripo fixture by `+0.001 m` along mesh-local Y. It exported the edited snapshot through the same FBX ZIP path and reopened the ZIP in the prototype. The source archives stayed unchanged.

| Fixture | Edited control point | ufbx | Unity 2022.3.62f2 and 6000.3.9f1 |
| --- | ---: | --- | --- |
| Ceramic plate | 14 | The edit moved one control point shared by seven polygon corners. All other positions, polygon connectivity and corner UVs matched exactly. | All four copies of the point at the UV seam moved by 1 mm. Triangle connectivity and UVs matched. |
| Skinned character | 1323 | The edit moved one control point shared by four polygon corners. All other positions, polygon connectivity, corner UVs and skin cluster indices and weights matched exactly. The edited point has four bone influences. | Both copies of the point at the UV seam moved by 1 mm. Triangle connectivity, UVs and weights matched. The Humanoid Avatar remained valid. |

The ufbx edit check also rejected each unedited original when asked to expect a move. The Unity comparison used the source mesh and applied the same expected offset independently. The largest base position error on the character was `4.66e-8 m`. The skinned pose comparison used an in-memory copy of the original Unity mesh with the expected move applied. The largest error across the three forearm rotations was `5.57e-7 m`.

## Compatibility decisions

- Both Tripo fixtures declare +X right, +Y up, +Z front, and 100 centimeters per source unit. The Comfy exporter emits these axis signs with `axisForward: '-Z'`. The prototype copies the source `UnitScaleFactor` and keeps `bakeSpaceTransform` disabled. Other axis conventions require separate validation.
- The first export prototype wrote one control point per render triangle corner. The adapter now reads the source control points, polygon boundaries, corner attributes and skin clusters from the patched Three.js loader. It passes polygon indices and per-corner layers to the patched Comfy writer while the preview continues to use triangles. `npm ci` applies both patches at their pinned dependency versions.
- The move command is exercised by the E00 browser harness. It writes the edited positions into a separate snapshot and retains the imported polygons, corner attributes and skin clusters. The export leaves the authored normals in place. The interactive geometry editor is a later stage. The prototype reports an export error for morph targets and meshes without source polygons.
- AT-01 and AT-02 have initial fixture results for the unedited and position edit paths. Full acceptance still requires a real animated FBX and visual comparison. The synthetic FBX is generated with the same candidate writer and tests animation preservation through reimport and another export. The GLB and geometry prototypes are tracked in the specification.

## Fixtures

The Tripo inputs were provided for local testing. Redistribution rights have not been established. Original archives, exported models, and Unity projects are kept under local inputs or ignored `test-results/` paths. The synthetic ribbon is generated by [`tools/e00/animated-fixture.mjs`](../tools/e00/animated-fixture.mjs).

| Local Tripo archive | SHA-256 |
| --- | --- |
| `ceramic plate 3d model.zip` | `ec8526eaab70239d8b7ac96ccdc57e7dc7f03b6929d3ca8b01b88c6236d7f4a3` |
| `tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip` | `262f01fc2dc745bc991fd8a14539793bc7b6331a0dcba508aae44556c5a5119d` |

## Reproduce on Windows

Use PowerShell from the repository root with Node.js, Python, Chrome, and Unity installed. Set `$tripo` to the directory containing the local Tripo files. The browser check also uses `tripo_convert_720eb24f-5864-47f1-8cfb-aed1d6df6c86.zip` for the Z-up case.

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd install --prefix test-results/e00-browser --save-exact playwright-core@1.65.1
npm.cmd run build
node tools/e00/animated-fixture.mjs
node tools/e00/browser.mjs $tripo $chrome 'test-results/e00/animated_fixture.fbx' --edited
```

The edited ZIPs under `test-results/e00/exports` have the suffix `_e00_edited.zip`. The move expectations are in `tools/e00/position-edits.json`. Set `$version` to the installed Unity version to run the Unity probe. Unity writes `e00-report.json` and `e00.log` in its generated project.

```powershell
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --animation 'test-results/e00/animated_fixture.fbx' --edited
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'e00.log'
$unityArgs = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'FbxProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
Get-Content (Join-Path $project 'e00-report.json')
```

Use `cl.exe` from an x64 Visual Studio Developer PowerShell to compile the independent reader. Run it against each pair in the generated project's `Assets/Fixtures` directory. It returns a nonzero exit code when polygon connectivity or source skin weights differ, or when an expected edit or its UVs fail verification. [ufbx v0.23.0 source and license](https://github.com/ufbx/ufbx/tree/v0.23.0)

```powershell
git clone --branch v0.23.0 --depth 1 https://github.com/ufbx/ufbx.git test-results/e00/ufbx
Push-Location test-results/e00/ufbx
cl.exe /nologo /O2 /std:c17 /I . ../../../tools/e00/inspect_fbx.c ufbx.c /Fe:inspect_fbx.exe
Pop-Location
$fixtures = Join-Path $project 'Assets/Fixtures'
foreach ($case in Get-ChildItem -LiteralPath $fixtures -Directory) {
  $original = (Get-ChildItem (Join-Path $case.FullName 'original') -Filter '*.fbx').FullName
  $exported = (Get-ChildItem (Join-Path $case.FullName 'exported') -Filter '*.fbx').FullName
  $expected = @()
  $editPath = Join-Path $case.FullName 'position-edit.json'
  if (Test-Path -LiteralPath $editPath) {
    $edit = Get-Content -LiteralPath $editPath -Raw | ConvertFrom-Json
    $expected = @($edit.controlPoint, $edit.offsetY.ToString([CultureInfo]::InvariantCulture))
  }
  & 'test-results/e00/ufbx/inspect_fbx.exe' $original $exported @expected
  if ($LASTEXITCODE -ne 0) { throw "ufbx check failed for $($case.Name)" }
}
```
