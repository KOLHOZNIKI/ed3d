# E00 corpus completion and PNG identity transfer

The eight remaining fixture IDs have controlled, project-owned inputs. The pinned files and generator use the repository's MIT license. GLBs contain one indexed primitive per mesh and embed all images. Tripo's user-provided F06 and F09 originals stay in local storage with checksums and import recipes. The included Meshy-generated F17 fixture retains its CC BY 4.0 attribution. [Fixture directory](../tools/e00/fixtures/corpus) · [Generator](../tools/e00/corpus-fixture.mjs) · [Repository license](../LICENSE) · [Local fixture provenance](E00_Report.md#fixture-provenance) · [F17 attribution](../tools/e00/fixtures/meshy-gambit-pawn-lo.LICENSE.md)

## Cases and expected results

| ID | Input and expected characteristics | E00 result |
| --- | --- | --- |
| F03 | Two separate patches with one eight-vertex hole each. One contour is planar and concave. The other contains a point 0.28 m above three noncollinear points in the reference plane. | The independent reader found both loops and matched indices, positions and normals through GLB export. The contours are inputs for Planar, Fan and Smooth. |
| F04 | Bottle with a protected 12-vertex mouth and two triangular sidewall defects. The `protectedLoop` reference names vertices 48–59. | The reader found exactly three boundary loops of sizes 3, 3 and 12, and the protection reference survived export. The fixture is ready for testing automatic repair. |
| F05 | Closed-back Grid patch with a four-sided hole and a separate Bridge mesh containing two components with one aligned eight-vertex loop each. | The reader matched the expected loops and both Bridge components. The original plate remains the Smooth/Grid operation reference. |
| F07 | Tray, handle and lid with one shared embedded PNG. The handle has two disconnected surfaces. The four components occupy disjoint UV regions. | The reader matched the three object nodes, four components, all UVs, and the shared PNG payload on export. |
| F08 | Two materials in one asset, each on its own mesh. Cutout samples UV0 with a 0.375 threshold. Veil samples UV1 with alpha blending. Each material has its own RGBA PNG, offset, rotation and scale. | GLB export preserved both coordinate sets, map channels, texture transforms, alpha settings and exact embedded image bytes. The FBX direct-bake prototype separately covers its single-material affine-profile case. |
| F11 | Wide torso with one skinned mesh, eight joints, known bind offsets and `TorsoSweep` at 0, 0.5 and 1 s. The torso spans 1.40 m at mid-height and uses a three-joint blend at the reference point. | Joint hierarchy, inverse bind matrices, indices and weights survived export. The mid-clip reference point moved from `(0.70, 1.05, 0)` to approximately `(0.640913, 1.315514, 0)` m in both files. |
| F12 | A GLB with a translated root, −90° X rotation, 0.01 scale, an intermediate node and the `ReferenceLift` clip. The FBX counterpart has Z-up metadata, 2.54 cm per unit, a transformed root, intermediate node and authored motion. | GLB export preserved the hierarchy, root transform and one-second clip. The moving node's center was `(2,3,3.75)`, `(2,3.5,3.75)`, `(2,3,3.75)` m at the three keys. ufbx verified the FBX hierarchy, axes, units and 6.35 mm midpoint displacement. E00 rejected that FBX with its supported-axis diagnostic. |
| F16 | One GLB index references vertex 19 in a four-position array. A second GLB has three triangles sharing edge `(0,1)`. An FBX ZIP references an omitted Base Color PNG. | E00 rejected the invalid index and missing map while keeping the previous model exportable. It warned about one non-manifold indexed edge and preserved the defective topology for repair testing. |

All eight conformant GLB pairs passed the independent reader and the Khronos validator with zero errors. The browser probe ran on Chrome 158.0.8127.37 and made zero external requests. F16's topology check uses authored vertex indices so split UVs and coincident points retain their own edges. F03, F04, F05 and F07 exercise fixture semantics. Their full repair and extraction operations follow the stage plan. [Independent checks](../tools/e00/inspect_corpus.py) · [Stage plan](AssetFixer_Technical_Specification_v1.0.md#sec-21) · [F08 FBX bake evidence](E00_UV_Transforms_Alpha.md)

## PNG identity transfer

A square FBX covers a 64 × 64 straight RGBA8 image with gradients, high-frequency changes and nonzero RGB behind zero alpha. The harness copies the original corner UVs to the target channel and uses the original dimensions, identity transform and clamp addressing. The application imports the fixture, runs the production direct-bake worker and writes its regular FBX ZIP. The check decodes both PNGs independently and excludes the perimeter and shared diagonal from the interior metric.

All **3,782 interior texels** matched exactly in R, G, B and A, including 16 texels with zero alpha and hidden RGB. Maximum error was **0/255 per channel** against the §22.2 limit of **1/255**. The worker reported all 4,096 texels covered. [Acceptance tolerance](AssetFixer_Technical_Specification_v1.0.md#sec-22) · [Browser probe](../tools/e00/corpus-browser.mjs)

## Pinned input hashes

| Input | SHA-256 |
| --- | --- |
| `f03_boundaries.glb` | `b278285833a3153f68bc60f662e769ffc2a857548e681cbc9fedae5daebffb08` |
| `f04_bottle.glb` | `1893fa2523cca03bd6814b7eda98a9d8af3b3b6784de48b7f6eb988c211095e4` |
| `f05_grid_bridge.glb` | `fe84d36b59e13d4df273b4c4d8d16045e3e1fa7026b116491ed99802b3a0726e` |
| `f07_shared_atlas.glb` | `6da87215fb38176385f09899098008ce576c48d2c82592ebc2c9e260adbe0910` |
| `f08_material_bindings.glb` | `0adfb35fed47cd59a8b33d1b3cea8ef69ca7e72c9ccde900f5adf4b754c29517` |
| `f11_wide_torso.glb` | `7f4f6f840064f18395e6cce06fa1acca9d0f6c13ce7366c6b5c45a8f373dd4bf` |
| `f12_coordinate_root.glb` | `c8ee684fee65475f2fc6884452c1ace2f42ce92f449e50251ea8c3a141e70cea` |
| `f12_zup_axes.fbx` | `8230073e4d260b93998ab03ea82892295470b2b3cc2ab1f99e9c30bd39dd4946` |
| `f16_invalid_index.glb` | `f5303e46e760d5b46bd5b423ed376f614a53ee16d742f41673d1744997de1c50` |
| `f16_missing_texture.zip` | `eee1cab823c48e6d1ff7e2609a71ef38059fd7c83827a3e0a69fe5e089a54343` |
| `f16_non_manifold.glb` | `ea7c9fd9960e3d9f5f44e6af8578b0884dba3aab7ec736f88d8209dbfbeb6a41` |
| `identity.zip` | `2b345a4de9fa501f4a12b59863a9ecdf5e43a9676b56f0ee15c207fbe3bb2703` |

## Reproduce

Use the pinned browser and validator setup. The generator recreates all twelve inputs byte for byte in `test-results/e00/corpus/generated`. The browser uses the pinned files by default and writes eight GLB exports, the identity ZIP and `browser-report.json` under `test-results/e00/corpus`. The independent script writes `independent-report.json` there. [Browser and validator setup](E00_GLB_Round_Trip.md#reproduce-on-windows)

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$corpus = 'tools/e00/fixtures/corpus'
$outputs = 'test-results/e00/corpus'
node tools/e00/corpus-fixture.mjs
node tools/e00/corpus-browser.mjs $chrome
python -B tools/e00/inspect_corpus.py $corpus $outputs
node tools/e00/validate-glb.mjs "$corpus/f08_material_bindings.glb" "$outputs/f08_material_bindings_e00.glb"
```

Build `inspect_fbx` with ufbx v0.23.0 and run `inspect_fbx --f12-source tools/e00/fixtures/corpus/f12_zup_axes.fbx` for the coordinate control. For identity, unpack the input and baked ZIPs separately and use `inspect_fbx <input.fbx> <output.fbx> --baked <output/uv-atlas-source-corners.bin>`. [Native reader setup](E00_FBX_Round_Trip.md#reproduce-on-windows)
