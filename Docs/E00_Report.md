# AssetFixer E00 verification and E01 readiness

**Status on 2026-11-27. The E00 prototypes have answered all seven questions in §21.4 on the verified profiles. The §7.7 topology and generator round-trips have results for the tested Tripo and Meshy files. The E00 acceptance gate remains open.** Corpus preparation still has gaps. The four measured memory phases fit on the benchmark workstation. The separate work-PC check specified in §20.2 has no recorded result. [Implementation stages](AssetFixer_Technical_Specification_v1.0.md#sec-21) · [Compatibility](AssetFixer_Technical_Specification_v1.0.md#sec-07) · [Corpus](AssetFixer_Technical_Specification_v1.0.md#sec-22) · [Benchmark setup](AssetFixer_Technical_Specification_v1.0.md#sec-20)

## Verified results

| Check | Fixture and observed result | Evidence |
| --- | --- | --- |
| Static FBX ZIP | Tripo plate. 4,577 control points, 5,134 polygons, and 9,138 triangles. ufbx matched positions, polygon connectivity and corner UVs. Both Unity versions matched base geometry and linked Base Color. | [FBX round-trip](E00_FBX_Round_Trip.md#results) |
| Skinned FBX ZIP | Tripo character. 8,829 control points, 17,623 triangles, and 67 bones. ufbx matched original skin cluster indices and weights exactly. Unity retained the Humanoid Avatar and linked Base Color and Normal. Maximum world-space difference across three forearm rotations was `5.57e-7 m`. The Tripo source has no clips. | [FBX round-trip](E00_FBX_Round_Trip.md#results) |
| Actual local geometry edit | One control point on a UV seam moved by 1 mm on each Tripo FBX. The plate's four Unity vertex copies and the character's two copies moved together. Polygon connectivity, corner UVs and original skin weights survived. The maximum Unity base-position difference from the expected character edit was `4.66e-8 m`. | [Position edit](E00_FBX_Round_Trip.md#position-edit-round-trip) |
| F01/F02 topology seam | A checker cube and a detached triangle share a position and one corner's UV and normal. A 31.25 mm edit moved only the cube's control point. Unity moved all three of its render copies and kept the coincident triangle vertex fixed. ufbx matched all 13 triangle boundaries, and both readers measured zero change in corner UVs and normals. The hard-normal angle stayed at 90°. | [F01/F02 topology seam](E00_Topology_Seams.md) |
| FBX animation | The synthetic two-bone ribbon matched at 21 Unity samples, including the keyed extrema. A separate authored Maya/Kenney FBX retained one clip, 45 bones, and exact skin weights. ufbx retained the authored range of `0–20/24 s` and measured a maximum deformation difference of `1.02e-6 m`. Unity imported the same `16/24 s` keyed interval from both files and measured `1.72e-4 m` maximum difference over 21 samples, within the fixture tolerance of `5.33e-4 m`. | [Authored FBX animation](E00_FBX_Round_Trip.md#authored-animation-round-trip) |
| Self-contained GLB | The Tripo character retained geometry, triangle indices, UV0, exact embedded JPEG and PNG bytes, 67 joint names/hierarchy and exact joint and weight arrays. The adapter corrected rounding in 22 inverse bind matrix rows. Independent skin evaluation measured at most `1.01e-7 m` difference. The Khronos validator went from 22 errors to zero and reported three existing warnings on each file. | [GLB round-trip](E00_GLB_Round_Trip.md) |
| GLB position edit | One of 36,197 position entries moved 1 mm along local Y. An independent parser matched all other positions, triangle indices, UVs, normals, 67 joint names and hierarchy, joint indices, weights, and the embedded texture bytes. The edited file reopened and produced zero Khronos validator errors. | [GLB position edit](E00_GLB_Round_Trip.md#position-edit-round-trip) |
| F17 compressed GLB | The published Dioramas pawn uses Meshy 7.1 geometry, Meshopt, quantization and WebP. It opened, exported and reopened in Chrome offline. glTF Transform verified all 19,274 positions, normals and UVs and all 28,069 triangles, material and texture bindings and three exact WebP payloads. Export keeps quantization and WebP and writes decoded geometry without Meshopt compression. | [F17 compressed GLB](E00_F17.md) |
| F17 compressed GLB position edit | One pawn vertex moved 32 quantization steps along Y, or 0.929 mm in world space. The edited GLB reopened offline. The independent reader matched all other positions, the full index array, UVs, authored normals, material and sampler settings, and all three WebP payloads. | [F17 position edit](E00_F17.md#position-edit-round-trip) |
| xatlas | Both Tripo FBX fixtures retained source control points, corner attributes and skin through seam splits. Each exported corner maps back to its source corner. Unity matched character weights exactly. Seven imported character normals had vector differences above `1e-5`, with maximum angle about `0.04°`. ufbx measured `1.21e-6°` maximum corner angle for both FBX files. | [xatlas](E00_XAtlas.md) |
| Direct texture rebake | Plate Base Color at 2396 × 2396. Character Base Color, Normal, Roughness and Metallic at 2828 × 2842. The final repack had 49 and 511 charts respectively. The FBX links Base Color and Normal where present and packages the two scalar character maps for manual assignment. Six views in both Unity versions showed no new dark seam lines after dilation. Mean lit seam error was `0.09/255` and `0.54/255` respectively. The character's highest seam pixel error was `46/255`. Local resampling differences remain at high-contrast transitions. | [Texture rebake](E00_Texture_Rebake.md) |
| UV transform and alpha bake | A project-generated folded mesh with rotation, non-uniform scale, offset, mixed address modes and a UV seam. Cutout and Fade both retained the pattern on the exported atlas. Unity matched 1,400 interior RGBA samples exactly in each mode, including 133 with hidden RGB. The mean composite RGB error was at most `0.310/255`. | [UV transforms and alpha](E00_UV_Transforms_Alpha.md) |
| Directional normal bake | A controlled F14 fixture exercised 37° rotation and a separate 23° rotation with a handedness change. Unity measured at most 0.517° and 0.257° world-space error away from edges, with no preferred-light reversals. The copied-RGB control reached 78.96° on the mirrored panel and reversed its preferred light. | [Directional normal map](E00_Directional_Normals.md) |
| 3D brush | The exported plate retained one stroke across two new UV seams. Both Unity versions measured zero gaps at 323 samples around the crossings and at 1,168 centerline samples. All 310,242 visible underside pixels matched. Two pixels away from the crossings blended brush and base color under filtering. Undo restored the previous PNG byte for byte. | [3D brush](E00_3D_Brush.md) |
| Smooth and Grid Fill | Same eight-edge cavity across an original plate UV seam. Smooth rebuilt eight triangles and moved the center by 1.865 mm. Grid rebuilt four quads and moved the center by 1.569 mm. Both Unity versions retained all eight boundary joins, both center UV variants, and the 9,130 outside triangles exactly. ufbx independently reconstructed each expected patch and matched the positions and corner UVs. | [Smooth and Grid Fill](E00_Smooth_Grid.md) |
| Typical-model memory | Eight Chrome cycles with 50,000 triangles, 100 bones and four 2K inputs. The highest private commit was 1,607 MiB during bake. The final three closes stayed within 15 MiB, and memory fell from 1,365 MiB to 736 MiB after diagnostic GC and an additional 20 seconds idle. The empty baseline was 368 MiB. A real Tripo character reached 1,785 MiB private commit during bake. | [Memory benchmark](E00_Memory.md) |
| Build and controlled failures | Release and Debug builds passed the type check. The Windows launcher served the selected build from a different working directory. The Release script installed dependencies in a clean copy. Browser probes verified missing texture, ZIP path traversal and unsupported Z-up diagnostics. The local workflows made no external requests. | [Build and launch](../README.md#local-development), [FBX input checks](E00_FBX_Round_Trip.md#results) |

Unity evidence uses 2022.3.62f2 and 6000.3.9f1. Baseline FBX imports used Generic rigs, imported normals, calculated MikkTSpace tangents, four skin influences, file scale, and mesh and animation compression disabled. Humanoid validity was checked separately. Bake and brush render comparisons used fixed cameras, uncompressed maps and mipmaps. GLB evidence comes from Chrome, an independent Python reader and the Khronos validator.

## Backend decisions and supported profile

Versions are pinned in [package.json](../package.json) and [package-lock.json](../package-lock.json). Update either patched dependency together with its round-trip checks.

| Area | Decision and rationale | Verified limits and consequences |
| --- | --- | --- |
| Runtime and build | Use strict TypeScript 7.0.2, Vite 8.4.0, and Three.js 0.187.0 with WebGL2. Workers perform xatlas, bake and brush jobs locally. | The current application is the E00 prototype on Windows. Performance, long-session behavior, resource budgeting and context recovery remain open. |
| FBX read and topology | Keep the pinned Three.js FBXLoader with a patch that records raw control points, polygon boundaries, per-corner attributes, raw skin clusters, authored clip limits and the render-corner map. Use that provenance to build stable document IDs in E01. | The verified path uses binary FBX with +X right, +Y up and +Z front. The two Tripo assets use 100 cm per source unit. F01/F02 verifies independent FBX points even when one corner's position, UV and normal are identical. The working document still needs its own topological IDs and resource ownership. |
| FBX write and packaging | Use patched `@comfyorg/fbx-exporter-three@1.0.2` for source polygon/control-point indexing, raw cluster preservation and authored take timing. Apply patches with `patch-package@8.0.1`. Use `fflate@0.8.3` for local ZIPs with FBX, PNG/JPEG maps and a manifest. Retain `ufbx@0.23.0` as the independent reader. | Verified skin has at most four influences and the authored animation has one layer and one clip. FBX export with morph targets is blocked. Other axes, complex rigs, animation layers, richer material graphs and embedded texture variations are outside the verified profile. External maps the adapter cannot bind are inventoried in the ZIP. ZIP policy limits are 160 MiB input, 128 MiB per expanded entry, 256 MiB total expanded size and 256 entries. |
| GLB read and write | Use the pinned Three.js GLTFLoader/Exporter, exact-weight loading, bundled Meshopt decoding, and embedded image pass-through. Verify with the independent Python and glTF Transform readers and `gltf-validator@2.0.0-dev.3.10`. | Verified no-op and single-position edits on the uncompressed Tripo character and the static Meshy-generated F17 GLB. F17 uses required `EXT_meshopt_compression`, `KHR_mesh_quantization` and embedded `EXT_texture_webp`. Export keeps quantization and WebP and writes decoded geometry. Draco and KTX2/BasisU are outside the supported profile. Editing GLB textures, authored GLB animation, morphs and Unity GLB import have no E00 fixture result. |
| Automatic UV | Use the thin `xatlas-wasm@0.1.3` adapter over source control-point triangles. Preserve `xref` and the source corner map and reconstruct the render attributes with application code. This keeps source correspondence explicit across chart splits. | The tested operation accepts one unedited FBX mesh with one UV set. It exports triangles when chart edges cross original polygon diagonals. Multi-mesh atlases, morphs, GLB unwrap and unwrap after a geometry edit are outside this probe. Packing conflicts were detected at the final bake raster's texel centers and repacked. |
| Direct bake and normals | Use a CPU raster worker with barycentric sampling, sRGB handling for Base Color, linear handling for scalar maps and nearest-seed padding. Preserve straight RGBA with `fast-png@8.0.0` and carry alpha mode in the ZIP manifest for Unity. Convert tangential normals through source and target MikkTSpace frames with handedness. Promote the atlas from UV1 to the primary UV set for the baked Unity FBX and keep the original set second. | One material on one mesh. The tested alpha profile uses an RGBA8 PNG and an affine UV0 sampling matrix in the manifest. Native FBX rotation and separate alpha maps remain outside the tested profile. The method is a same-surface transfer. The real character normal result is a comparison of RGB-encoded world normals. |
| 3D brush | Keep the visible-projection prototype over the baked atlas. It writes a Base Color PNG snapshot and verifies reversibility. | Static opaque single-material mesh, fixed 24-viewport-pixel brush, update at pointer release. Topology-constrained footprints, skinned paint and the shared 2D/3D history are later work. |
| Smooth and Grid | Keep constrained Laplacian fairing for the single interior vertex of an eight-triangle fan and a 2 × 2 Coons grid for the four-sided fixture. The checked boundary and per-corner mapping travel with the edit. | This is the tested four-quad replacement case. General hole detection, other loops or densities, protected openings, new-hole UV generation and Bridge are later geometry work. |

The source topology, original resource bytes and working revisions are separate concerns for E01. The E00 Three.js scene and render buffers are adapters. The archived prototypes and probes remain regression entry points.

## Requirement coverage

These are bounded E00 outcomes. Full V1 acceptance still follows [§22.5](AssetFixer_Technical_Specification_v1.0.md#sec-22).

| Requirement or test | E00 status |
| --- | --- |
| USR-01, USR-02 and AT-01 | Local browser workflow and the listed FBX/GLB round-trips verified. |
| USR-06, USR-17 and CORE-01–03, CORE-06–08 | Source IDs, corner provenance, preservation after a local move and original-byte retention verified on the listed paths. F01/F02 verifies the independent coincident points. A dedicated working document is open. |
| AT-02 | Fixture pass for the ribbon and one authored single-layer clip. The ribbon includes extrema. The authored clip evidence uses 21 samples and covers that clip only. |
| USR-08, UV-17 and AT-11 | Verified on the two Tripo FBX fixtures, including skin and the original UVs. Morph unwrap is blocked by the prototype. A dedicated adverse skin/morph fixture remains open. |
| USR-07, BAKE-01, BAKE-06, AT-12 and AT-13 | Same-surface opaque and transformed RGBA transfer, Cutout/Fade, controlled normal transfer on rotated and mirrored UVs, and collision detection at the bake resolution demonstrated. The complete multi-material F08 fixture remains open. |
| USR-03, PAINT3D-03, PAINT3D-05 and AT-07 | Static plate passes the seam and underside probe. The hidden neighboring-object and skinned cases have no positive result yet. |
| USR-15 and AT-18 | Smooth and Grid pass the limited four-quad repair. Other fill methods and the general repair workflow are assigned to E05/E08. |
| AT-31 | Missing-texture, unsafe ZIP-path and unsupported-axis failures tested. Full corrupt-index, non-manifold and adverse-morph corpus coverage remains open. |

## E00 prototype scope

| §21.4 question | Current determination | Evidence needed to close the remaining scope |
| --- | --- | --- |
| 1. Static and skinned FBX into Unity | Answered on the verified assets | Keep the Unity and ufbx checks as regressions. |
| 2. Preserved topology and weights before conversion | Answered on the verified Tripo FBX assets and on the F01/F02 topology fixture | Carry the no-op and edited F01/F02 checks into E01 to verify stable document IDs. |
| 3. Complete correspondence after xatlas | Answered on the two Tripo fixtures | Retain the original-corner and skin invariants in regression tests. |
| 4. Direct bake with seams, texture transforms and alpha | Answered for the explicit single-material RGBA profile | Keep the transformed Cutout/Fade and constant-color interior checks. Extend F08 to multiple materials and UV channels and add a standalone lossless identity transfer against the §22.2 `1/255` tolerance. |
| 5. Rotated/mirrored tangent-space normals | Answered on the controlled F14 fixture | Retain the floating-point Unity normal and lighting checks and the copied-RGB negative control. The maximum world-space error was 0.517° against the §22.2 limit of 2°. |
| 6. Minimal Smooth/Grid implementation | Answered for the tested four-sided contour | Preserve the pinned-boundary test. Broader methods belong to the E05/E08 repair stages. |
| 7. Typical-profile memory fit | Import, unwrap, rebake, export and repeated close fit on the recorded workstation at 1920 × 1080, DPR 1 | Record the separate §20.2 work-PC run. The available results cover Chrome process memory. Paint and undo, long-session behavior, resource budgets and dedicated VRAM remain unmeasured. |

## Before E01

Prepare the remaining §22.1 fixture inputs and record each source, permission for test use, expected invariants, and checksum. [Corpus and preservation criteria](AssetFixer_Technical_Specification_v1.0.md#sec-22)

The Tripo FBX and GLB fixtures and the Meshy-generated F17 GLB have no-op and edited results for the §7.7 compatibility check. Carry these recipes and reference exports forward as adapter regressions. IO-07 gives conditional scope to Draco and KTX2 for corresponding inputs and adapters. [Compatibility and IO-07](AssetFixer_Technical_Specification_v1.0.md#sec-07) · [Generator regression decision](AssetFixer_Technical_Specification_v1.0.md#sec-24)

### Corpus inventory

Six of the 18 fixture IDs have documented positive results. Eight have partial evidence or a candidate. Four still need a matching input. A positive result describes the listed checks. Each fixture needs the §22.1 provenance record before corpus sign-off.

| Fixture | State | Verified evidence or remaining preparation |
| --- | --- | --- |
| F01 | Verified | The project-owned checker cube retained all corner UVs and its 90° hard seams in both FBX exports. [Fixture and results](E00_Topology_Seams.md) |
| F02 | Verified | The same FBX has two independent points with identical source coordinates. Only the selected cube point moved. [Fixture and results](E00_Topology_Seams.md) |
| F03 | Partial | The plate supplies a Smooth fan. Prepare controlled concave planar and non-planar hole boundaries. |
| F04 | Candidate | The local Tripo bottle supplies a textured FBX. Identify or author a protected mouth and small defects with known boundaries. |
| F05 | Partial | The plate supplies a four-sided Grid cavity. Prepare the second case with two loops for Bridge. |
| F06 | Verified | Tripo plate with one color map. Static import, paint across seams, and Unity export reproduced. |
| F07 | Candidate | The local Tripo collection ZIPs each contain one FBX and one color map. Verify the object and component boundaries and actual atlas sharing, or prepare a controlled set. |
| F08 | Partial | The generated RGBA fixture covers a transform, an original seam, Cutout and Fade. Add multiple materials, different UV channels and expected bindings. |
| F09 | Verified | The Tripo character covers standard skin and poses. The authored Kenney FBX and synthetic ribbon supply clip checks. |
| F10 | Missing | Prepare body and clothing meshes sharing one skeleton with known bindings. |
| F11 | Candidate | Establish a wide-torso character fixture with reference joints, weights and offsets. Verify the Tripo candidate against these expectations. |
| F12 | Partial | The current input covers a Z-up refusal. Prepare a root transform, nonstandard scale and axes, intermediate nodes and a reference clip. |
| F13 | Missing | Prepare more than four influences and multiple morph targets. Set expected diagnostics and verify that unsupported data is reported before conversion. |
| F14 | Verified | The controlled directional normal map passed rotated and mirrored UVs in both Unity versions. |
| F15 | Missing | Prepare nearby surfaces with distinct patterns and expected paint and projection isolation. |
| F16 | Partial | Missing texture, unsafe ZIP path and unsupported-axis refusals passed. Add corrupt indices, non-manifold geometry and the applicable diagnostics. |
| F17 | Verified | The Meshy-generated Dioramas pawn requires Meshopt, quantization and WebP. Both no-op and edited exports passed offline round-trips. The independent reader matched the one expected position edit, topology, corner data and embedded textures. [Fixture and results](E00_F17.md) |
| F18 | Missing | Prepare large maps, a reproducible edit sequence and expected checkpoints. The current typical-asset benchmark covers four 2K inputs and repeated close. The saved-project recovery scenario uses E01's serializer. |

### Outstanding acceptance evidence

The standalone lossless PNG identity-transfer check still needs to demonstrate a maximum per-channel error of `1/255` on interior texels under identical sampling and format. The transformed alpha probe covers the separate constant-color tolerance. Add identity transfer to the texture fixtures. [Preservation criteria](AssetFixer_Technical_Specification_v1.0.md#sec-22) · [UV transforms and alpha](E00_UV_Transforms_Alpha.md)

The separate §20.2 check requires a recorded run on the user's work PC at 1920 × 1080 and DPR 1. Use the existing recipe and include repeated paint and undo when assessing the §20.3 requirement against unbounded growth after Import/Close/Undo. The observed peaks and eight-cycle trend characterize the recorded Windows and Chrome setup. Use the wider measurements to establish resource limits. [Benchmark and memory requirements](AssetFixer_Technical_Specification_v1.0.md#sec-20) · [Memory benchmark](E00_Memory.md)

### Work assigned to later stages

§22.1 puts fixture preparation in E00. §21.2 assigns full tool workflows to later stages, including general fill in E05/E08, extraction in E07, and shared rig and weight workflows in E09/E10. Full V1 readiness is evaluated in E12. [Implementation stages](AssetFixer_Technical_Specification_v1.0.md#sec-21) · [V1 readiness](AssetFixer_Technical_Specification_v1.0.md#sec-22)

E01 builds the working document with stable IDs, explicit ownership and immutable originals, a viewer with object selection, commands, versioned `.assetfixer` files and autosave. Its acceptance scenario opens a model, saves it, restarts, restores without the original files or network, and exports for verification. Carry the E00 geometry, skin, UV and Unity checks forward as adapter regressions. [Project and history](AssetFixer_Technical_Specification_v1.0.md#sec-06) · [E01 acceptance scenario](AssetFixer_Technical_Specification_v1.0.md#sec-21)

## Fixture provenance

The Tripo inputs are user-provided local files under `D:/downloads/Tripo`. The checksums below were verified against the local originals. Tripo redistribution permission has not been established. The Kenney FBX is read from the pinned ufbx corpus checkout and is used locally. Establish its asset-level distribution terms before repackaging it. The project-owned synthetic ribbon is regenerated using [animated-fixture.mjs](../tools/e00/animated-fixture.mjs).

| Input | Origin and expected content | SHA-256 |
| --- | --- | --- |
| `ceramic plate 3d model.zip` | Tripo static plate with Base Color | `ec8526eaab70239d8b7ac96ccdc57e7dc7f03b6929d3ca8b01b88c6236d7f4a3` |
| `tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip` | Tripo character FBX with 67 bones and no clips | `262f01fc2dc745bc991fd8a14539793bc7b6331a0dcba508aae44556c5a5119d` |
| `tripo_convert_720eb24f-5864-47f1-8cfb-aed1d6df6c86.zip` | Tripo Z-up FBX used for the axis refusal | `b1e9d3fde54c82d561f6838d5e43f23f46c3f95a8d132ff2f11b2c97f725526d` |
| `man character 3d model.glb` | Tripo uncompressed GLB with 67 bones and embedded Base Color and Normal | `ca424258eabe304d78b5834a7e77d463bc9acbd2443d97c8f1d60a2cfbee72ff` |
| `maya_kenney_character_7700_binary.fbx` | ufbx v0.23.0 corpus, 45 bones and one authored clip | `b84398b1876edb4a718615985a801393fcc0548e8e65a5c3ba133f30993c3b0e` |
| `animated_fixture.fbx` | Project-generated ribbon, two bones and one one-second clip. Hash of the local generated sample. | `b0deaa251d3cbcd901cd3ed5c65d279b8e89a43635a5898277c43e8c01b0ccfb` |
| `glass bottle 3d model.zip` | Local Tripo candidate for F04, textured FBX | `1e7e7239689680f9e732bc1f107777114aafc59b2836f3ac3c6e73ba74c6813e` |
| `household items 3d model.zip` | Local Tripo candidate for F07, FBX and Base Color | `108a11d206c020b43800ef17113f8d39856359d9e7548f7b60984fa8413f7c47` |
| `household objects 3d model.zip` | Local Tripo candidate for F07, FBX and Base Color | `ef2f4044da2fdf81e747f83c4143d8e55db8cc8036d30666cbd4943a5959d1f4` |
| `furniture set 3d model.zip` | Local Tripo candidate for F07, FBX and Base Color | `a2ea2484187df777937b87a1c37001f063281c6e694b400064d3268ebff0bbc7` |

## Reproduce and locate evidence

Use [build-release.cmd](../build-release.cmd) and [build-debug.cmd](../build-debug.cmd) for the Windows builds and [run.cmd](../run.cmd) to serve them. Node.js 22.16.0 passed both builds for this report. The detailed reports linked above give fixture setup, test flags and Unity batch commands. Use the pinned Playwright 1.65.1 with installed Chrome, the ufbx v0.23.0 native reader for FBX, and the Python reader and pinned Khronos validator for GLB.

Reference exports are under the ignored workspace path `test-results/e00/exports/`. For the plate and character FBX names, the ZIP suffixes are `_e00`, `_e00_edited`, `_e00_atlas`, and `_e00_baked`. The plate also has `_e00_painted`, `_e00_smooth`, and `_e00_grid`. The animation references are `animated_fixture_e00.zip` and `maya_kenney_character_7700_binary_e00.zip`. The GLB references are `man character 3d model_e00.glb` and `man character 3d model_e00_edited.glb`. Raw reports and screenshots remain under `test-results/e00/` and its generated Unity projects. The linked recipes regenerate the artifacts on another checkout with access to the fixtures.

The project-generated alpha fixtures, their source checksums and the two `alpha_transform_*_e00_baked.zip` references are recorded in the [UV transform and alpha report](E00_UV_Transforms_Alpha.md).

The generated F14 fixture and `directional_normals_e00_baked.zip` are recorded in the [directional normal report](E00_Directional_Normals.md).

The typical-model generator, input checksum, raw process samples and memory benchmark commands are recorded in the [memory report](E00_Memory.md).

The published F17 GLB, license, checksums, offline tests and no-op and edited exports are recorded in the [compressed GLB report](E00_F17.md).
