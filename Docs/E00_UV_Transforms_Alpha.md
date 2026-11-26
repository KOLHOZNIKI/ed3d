# E00 UV transform and alpha bake

The generated fixture is one folded mesh with two connected quads, one material and a 256 × 256 RGBA8 PNG. It combines an asymmetric color pattern with alpha values 0, 64, 140 and 255. Its source UVs have a seam at the fold, with an offset of one complete texture repeat across that seam after transformation. The source wraps horizontally and clamps vertically. Two runs use the same mesh and PNG with either a 0.5 alpha cutoff or straight alpha blending.

The input FBX ZIP declares the reference transform in `manifest.json` under `assetFixerMaterial.uvTransform`. The six coefficients encode a UV0 sampling matrix with scale 1.25 × 0.82, rotation 27° and offset (0.17, −0.12). This is an E00 package convention. The original Unity reference applies the same transform independently to the imported source UV vertices because the Built-in Standard texture controls expose tiling and offset. The fixture generator is project-owned and licensed with the repository. [Fixture generator](../tools/e00/alpha-fixture.mjs)

The bake samples the transformed coordinates on the original surface, transfers the RGBA values to the xatlas layout and pads its islands. Base Color interpolation uses linear-light RGB and a separate linear alpha. The RGBA PNG decoder and encoder keep straight RGB, including texels with zero alpha. The output FBX uses the atlas as the primary UV set with identity texture sampling and retains the original UV set as the second set. The manifest keeps the alpha mode and mask threshold. [fast-png](https://github.com/image-js/fast-png)

## Unity import and comparison

For the baked FBX ZIP, extract each package into its own Unity asset folder. In a Built-in Render Pipeline project, install [AssetFixerAlphaMaterialImporter.cs](../tools/unity/AssetFixerAlphaMaterialImporter.cs) in `Assets/Editor` and import or reimport the FBX with its material import mode set to **Import Standard**. The importer applies **Cutout** or **Fade** using the adjacent manifest. The default FBX importer produced an opaque material for both variants without the helper. The equivalent manual setup uses the linked Base Color PNG with alpha from the input and the material mode and cutoff in the manifest. [Unity material import callback](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/AssetPostprocessor.OnPostprocessMaterial.html)

Chrome opened both source ZIPs, generated two atlas charts, baked to 2276 × 1818, exported the FBX ZIPs, and reopened the exported packages. Each output PNG retained all four reference alpha values and had 387,523 zero-alpha texels with nonzero RGB.

Unity 2022.3.62f2 and 6000.3.9f1 imported the baked geometry and linked PNG with the correct Standard material mode already applied by the helper. The probe used gamma color space, uncompressed textures, trilinear filtering with mipmaps, and a 640 × 640 fixed camera. It measured opacity by capturing the same model against black and white backgrounds. A reference with identity UV sampling served as a negative control.

| Check | Cutout | Fade |
| --- | ---: | ---: |
| Interior RGBA samples matching exactly, per Unity version | 1,400 | 1,400 |
| Interior samples retaining hidden RGB at zero alpha | 133 | 133 |
| Fully transparent rendered pixels on the model | 72,167 | 32,052 |
| Rendered pixels near alpha 64/255 and 140/255 | 0 | 37,879 and 67,165 |
| Interior rendered opacity samples matching exactly | 255,143 | 244,143 |
| Mean rendered composite RGB difference across the model, worst of the two Unity versions | 0.285/255 | 0.310/255 |
| Mean rendered opacity difference across the model | 0.031/255 | 0.156/255 |

The mask had binary opacity in both Unity versions. The reference without the transform differed by at least 54.9/255 mean RGB across the surface. ufbx independently matched all six source positions, the original UV values and normals, and verified the four valid atlas triangles.

This covers a single material with local RGBA8 Base Color, explicit affine UV0 sampling and mask or blend alpha. Native FBX rotation properties and pivots, separate alpha maps, transformed normal maps, multi-material combinations and URP/HDRP are outside this probe. The tests establish the transformed transfer and the color tolerance inside constant-color patches. A separate identity-transfer fixture remains part of the complete corpus.

## Reproduce on Windows

Use the same Chrome, Unity and Playwright setup as the [E00 texture rebake report](E00_Texture_Rebake.md#reproduce-on-windows).

```powershell
$tripo = 'D:/downloads/Tripo'
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
node tools/e00/alpha-fixture.mjs
npm.cmd run build
node tools/e00/browser.mjs $tripo $chrome --rebake --alpha
$version = '2022.3.62f2'
$project = python tools/e00/fixtures.py $tripo $version --alpha
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'alpha-unity.log'
$unityArgs = @('-batchmode', '-force-d3d11', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'AlphaBakeProbe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $unityArgs -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity alpha probe failed. See $log" }
Get-Content (Join-Path $project 'alpha-report.json')
```

The self-contained input ZIPs are under `test-results/e00/alpha-fixture/`. Their observed SHA-256 hashes for this run were `1a1270e9e13a96313fe4007797221acd36145e375422c1dd8ff21b056e7e5160` for mask and `944669b0d0a91cc985e52c0cf8bdcb5eb3e36dd7779f2c3f8aec5f90ea9bac82` for blend. The baked ZIPs in `test-results/e00/exports/` have the suffix `_e00_baked.zip`. The Unity project has original and baked captures under `captures/`. The independent reader uses `inspect_fbx --baked` with `uv-atlas-source-corners.bin` as in the original rebake report.
