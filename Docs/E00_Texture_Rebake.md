# E00 texture rebake

The later [UV transform and alpha probe](E00_UV_Transforms_Alpha.md) extends the same export path to one transformed RGBA8 Base Color with mask or blend alpha.

**Generate UV atlas** builds a candidate UV1 layout. **Rebake textures** transfers maps from the original import to that layout in a local browser worker. **Discard texture bake** restores the atlas with the source textures on UV0. The viewport shows the original import during this probe. In the baked FBX ZIP, the atlas becomes the first UV set so Unity materials and MikkTSpace tangent generation use it by default. The original UV coordinates remain in the second set.

The worker rasterizes each atlas triangle and samples the corresponding source triangle by barycentric interpolation. Base color is bilinearly sampled in linear light and encoded as sRGB PNG. Roughness and Metallic are processed as linear data. The normal pass interpolates both MikkTSpace frames, transforms the sampled normal through their shared surface space, and normalizes the result before writing the texel. It uses both tangent signs to handle mirrored UVs. [Three.js MikkTSpace implementation](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/libs/mikktspace.module.js) and [Unity MikkTSpace importer](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/ModelImporterTangents.CalculateMikk.html)

The original xatlas packing produced conflicts at some interior texel centers. The atlas worker gives conflicting faces individual chart constraints and repacks until the bake raster has no conflicting writes. It requests eight xatlas texels of spacing, which becomes sixteen at twice the packing resolution. The bake extends valid samples into unused texels with a nearest-seed flood. Each padded texel comes from one valid sample. Filling the remaining space removed the dark stipple seen in the first Unity plate render with bounded padding.

## Fixture results

| Tripo fixture | Baked PNGs | Dimensions | xatlas charts | Faces constrained after overlap checks | Atlas triangles with no covered texel center |
| --- | --- | --- | ---: | ---: | ---: |
| Ceramic plate | Base Color | 2396 × 2396 | 49 | 4 | 1 |
| Skinned character | Base Color, Normal, Roughness, Metallic | 2828 × 2842 | 511 | 21 | 0 |

Base Color and Normal are linked in the FBX. The Tripo character's Roughness and Metallic were separate files in the source and remain separate linear PNGs in `unassigned/` for manual material setup. In Unity, keep Base Color in sRGB, import Normal as a Normal Map, and turn off sRGB for the two scalar maps. The verification configured the texture importer to preserve the full atlas size, with NPOT scaling and compression disabled, mipmaps enabled, and trilinear filtering.

ufbx verified all source positions, polygon boundaries, original corner UVs, and the character's 67 skin clusters, joint indices, and weights. Every exported triangle has valid atlas UV area. The maximum change in serialized corner normals was within `1.21e-6°`.

## Unity appearance and seams

Unity 2022.3.62f2 and 6000.3.9f1 rendered the imported files at 768 × 768 on Direct3D 11. The probe compared six camera views, including a wider view for mip filtering, against both the original FBX and a control with the same triangulation as the baked FBX and the original UV0 maps. It captured controlled lighting, Base Color, reconstructed world normals, and each scalar map. The seam mask marks a two-screen-pixel band along shared edges that were continuous in the original UVs and split in the new atlas.

| Fixture | New seams in imported mesh | Visible seam pixels across six views | Mean lit RGB error at seams, out of 255 | 95th percentile, out of 255 | Mean lit RGB error away from seams, out of 255 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ceramic plate | 259 | 46,749 | 0.09 | 1 | 0.08 |
| Skinned character | 1,207 | 49,012 | 0.54 | 3 | 0.47 |

The six comparison views and enlarged crops showed no new visible dark lines along the new seams after padding. Local resampling differences remain at high-contrast transitions on the character. The largest individual seam pixel error in the lit pass was 5/255 for the plate and 46/255 for the character. The character's world-normal capture had mean seam RGB error 0.85/255 and 95th percentile 4/255. It uses RGB-encoded normals for this comparison. The comparison with matching triangulation had zero silhouette-pixel differences on both assets.

This probe covers one material on one opaque, unedited FBX mesh with an original UV set and local PNG or JPEG maps. UV overlap detection tests interior coverage at the bake resolution. The comparison uses uncompressed textures at the tested views and mip footprints.

## Reproduce on Windows

Use the local Tripo fixtures, Chrome and ufbx setup from the [FBX round-trip report](E00_FBX_Round_Trip.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --rebake
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --rebake
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'rebake-unity.log'
$unityArgs = @('-batchmode', '-force-d3d11', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'TextureBakeProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity probe failed. See $log" }
Get-Content (Join-Path $project 'rebake-report.json')
```

The browser writes `*_e00_baked.zip` under `test-results/e00/exports`. Unity writes the rendered pairs under the generated project's `captures/` directory. With the native reader built, check each exported FBX independently.

```powershell
foreach ($case in Get-ChildItem (Join-Path $project 'Assets/Fixtures') -Directory) {
  $source = (Get-ChildItem (Join-Path $case.FullName 'original') -Filter '*.fbx').FullName
  $exported = (Get-ChildItem (Join-Path $case.FullName 'exported') -Filter '*.fbx').FullName
  $map = Join-Path $case.FullName 'uv-atlas-source-corners.bin'
  & 'test-results/e00/ufbx/inspect_fbx.exe' $source $exported --baked $map
  if ($LASTEXITCODE -ne 0) { throw "ufbx check failed for $($case.Name)" }
}
```
