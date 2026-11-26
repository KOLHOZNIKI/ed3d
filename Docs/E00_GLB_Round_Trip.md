# E00 Tripo GLB round-trip

The browser prototype opened `man character 3d model.glb`, built a new binary with the pinned Three.js GLTFExporter and reopened that binary. The Playwright run also checked that the page made no external requests. A separate Python reader compared the original and exported GLB containers and evaluated their skins without Three.js. The Khronos glTF Validator checked both files. [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator)

| Data | Result |
| --- | --- |
| Geometry | All 36,197 positions and normals matched exactly. The 52,869 indices for 17,623 triangles matched in order. The `FB_ngon_encoding` marker stayed on the primitive. |
| UVs | All 36,197 `TEXCOORD_0` values matched exactly. Both material texture slots still reference UV channel 0. |
| Textures | Base Color JPEG at 4096 × 4096 and Normal PNG at 2048 × 2048 retained their original payload bytes, names, MIME types and material assignments. |
| Skeleton and weights | All 67 joint names, their order, and the joint parent hierarchy matched. `JOINTS_0` and `WEIGHTS_0` matched exactly. The largest world joint matrix component difference was `5.53e-8`. |
| Skin binding | The original had 22 non-affine inverse bind rows caused by rounding. The adapter corrected each homogeneous component to 1. All other inverse bind matrix components matched exactly. The largest correction was `1.19e-7`. |
| Deformation | The largest position difference over all vertices was `1.01e-7 m` at rest and `1.00e-7 m` after rotating `Left_LowerArm` locally by 0.55 radians. The reference bend moved vertices by up to 0.136 m. |

Khronos glTF Validator `2.0.0-dev.3.10` reported 22 inverse bind errors in the source and zero errors in the export. Both files produced the same three warnings about runtime-generated tangent space and the skinned mesh node's location and local transform. The validator reports `FB_ngon_encoding` as an unsupported extension at informational severity. The unused declaration of `KHR_materials_volume` disappears on export. [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)

## Position edit round-trip

The E00 browser probe imports a fresh copy of the same Tripo source, adds `0.001 m` along local Y to position accessor index `19618` (zero-based), and sends the edited scene through the same GLB exporter. The closest other source vertex is 2.77 mm away and the edited index belongs to two triangles. Chrome reopens `man character 3d model_e00_edited.glb` with 17,623 triangles and 67 bones. [Edit fixture](../tools/e00/glb-position-edit.json) · [Browser probe](../tools/e00/browser.mjs)

| Check | Independent result |
| --- | --- |
| Position | Exactly one of 36,197 positions changed. Y went from `-0.051859091967344284` to `-0.05085909366607666 m`, matching the expected rounded float32 result. The observed offset was `(0, 0.000999998301267624, 0) m`. |
| Topology and attributes | All 52,869 indices matched in order. The polygon marker and all `TEXCOORD_0`, `NORMAL`, `JOINTS_0`, and `WEIGHTS_0` values matched. |
| Textures | The embedded Base Color JPEG and Normal PNG matched byte for byte, with their names, MIME types, material slots and UV channels intact. |
| Skeleton and deformation | All 67 joint names, order and joint parent links matched. The largest joint world matrix component difference was `5.53e-8`. The same 22 source inverse bind rows received the existing affine correction. Against the original skin with the expected position edit applied independently, the maximum error was `1.01e-7 m` at rest and `1.00e-7 m` after bending the forearm. |
| Validation | The edited GLB had zero Khronos validator errors and the same three warnings as the original. The position probe rejected the no-op export when the edit was expected. |

The edited reference GLB has SHA-256 `5ed3731aa7edc141647ed63a88e58ebfc66548d22006e8f24b8809833ad7c711`. The source checksum matches the earlier round-trip. The JSON evidence is in `test-results/e00/glb-edited-round-trip-report.json` and `test-results/e00/glb-edited-validator-report.json`.

## Scope and inputs

- These checks cover a self-contained GLB with one scene, one indexed triangle primitive per mesh, embedded JPEG/PNG images and up to four skin influences per vertex. The edit targets a single position accessor entry and retains the authored normal. The fixture has no animation clips. Compressed geometry and other extensions remain separate E00 cases.
- The loader's exact-weight option is enabled for this GLB path and checks the skin weights before export. The writer preserves the source image payload and excludes container alignment bytes from the image buffer view. The vendor marker is preserved with the original triangle order.
- The user-provided original stays in the local Tripo directory. Source SHA-256 is `ca424258eabe304d78b5834a7e77d463bc9acbd2443d97c8f1d60a2cfbee72ff`. The model and exported binary are local test artifacts.

## Reproduce on Windows

Run in the repository root. The browser harness also runs its baseline FBX ZIP cases from the same Tripo directory.

```powershell
$tripo = 'D:/downloads/Tripo'
$source = Join-Path $tripo 'man character 3d model.glb'
$exported = 'test-results/e00/exports/man character 3d model_e00.glb'
$edited = 'test-results/e00/exports/man character 3d model_e00_edited.glb'
npm.cmd ci
npm.cmd install --prefix test-results/e00-browser --save-exact playwright-core@1.65.1
npm.cmd install --prefix test-results/e00-glb-validator --save-exact gltf-validator@2.0.0-dev.3.10
npm.cmd run build
node tools/e00/browser.mjs $tripo 'C:/Program Files/Google/Chrome/Application/chrome.exe' --glb $source --glb-edited
python tools/e00/inspect_glb.py $source $exported
node tools/e00/validate-glb.mjs $source $exported
python tools/e00/inspect_glb.py $source $edited --position-edit tools/e00/glb-position-edit.json
node tools/e00/validate-glb.mjs $source $edited
```
