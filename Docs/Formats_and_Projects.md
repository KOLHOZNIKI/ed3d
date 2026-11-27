# Format and project support

## Exchange formats

| Data | Binary FBX and FBX ZIP | Self-contained GLB 2.0 |
| --- | --- | --- |
| Geometry | Source FBX control points, polygons and corner layers are retained through the supported binary profile. Mesh commands preserve independent point identity and seam attributes. | One indexed triangle primitive per mesh in the supported input profile. Logical topology survives supported edits. The private polygon extension is retained while its source topology remains compatible. |
| Textures and materials | Linked PNG/JPEG, including maps in a ZIP or sibling folders. Missing and ambiguous input references offer manual local assignment. Export uses the Unity Phong profile with external maps, a manifest and compatibility reports. Auxiliary Roughness/Metallic files require manual Unity material assignment. | Embedded PNG/JPEG and the supported required WebP profile. PBR slots and supported texture transforms are preserved. Direct transfer supports the declared UV and material restrictions. |
| UV, alpha and normals | Source corner UVs and normal seams are retained. A baked FBX can place the target in UV0 and retain the original in UV1. The FBX alpha profile preserves straight RGBA Base Color, sampling transforms and material alpha in its tested setup. Directional normals are transferred in the source and target tangent frames. | UV channels, supported sampling transforms, embedded images, and mask/blend properties are preserved in the supported profile. Edited Base Color is embedded losslessly as PNG. |
| Skinning | Supported linear skin clusters and shared rigs are preserved. The viewport previews four influences and the writer retains wider source clusters until the user explicitly accepts an influence conversion. | One `JOINTS_0`/`WEIGHTS_0` set, with four influences per vertex. Near-affine inverse-bind rounding within the profile tolerance is corrected and reported. |
| Animation | Read and write supported skeletal takes, including source timing. Rest edits require review of affected clips. Supported clips can be adapted or explicitly excluded. Published diagnostic motions use sampled keys. | Supported skeletal tracks and published diagnostic clips are written. Both the working timeline and export honor the active compatibility decisions. |
| Unsupported entities | The writer blocks FBX morph export. **Export Original** retains the source bytes. Non-profile axes and vendor-specific FBX entities require a supported conversion. Unity avatar configuration belongs to the Unity import settings. | Meshopt decoding is bundled for the tested Meshy profile. Export writes regular GLB buffers. Draco, KTX2, additional joint sets and unlisted extensions are refused. Use the source tool to produce a supported GLB where needed. |

The local module accepts one scene or one FBX model per import. Standalone and batch exports target independent static objects created in **Extract**. Project labels and viewport visibility remain editor state. Export uses the source object hierarchy and its original visibility. Resource scope, known conversions, and original SHA-256 hashes appear in the compatibility reports.

## Project archives

`.assetfixer` is a ZIP with one UTF-8 `manifest.json` and content-addressed `blobs/<sha256>` entries. The manifest holds the document ID, name, revision, history budget, saved object hierarchy, original file references and working state. Each blob reference resolves through the resource table. The loader verifies its SHA-256 and length before rebuilding the document from the immutable originals. Equal blobs share one archive entry. Jobs, Undo and Redo history, current selection and playback state are session resources.

| Schema | Added persisted state |
| --- | --- |
| 1 | Originals, hierarchy and overrides, topology-related buffers, and initial paint and bake state. |
| 2 | Configurable history budget. Version 1 receives the 256 MiB default. |
| 3 | Per-binding tiled texture edits, stored as lossless PNG resources. |
| 4–5 | Logical mesh command replay and protected contours. |
| 6–8 | UV edits and transferred maps, independent assets, spatial projection coverage and repair data. |
| 9 | Working skeleton, source clip compatibility settings, and saved poses. |
| 10 | Weight influence locks, together with replayable weight edits. |
| 11 | Humanoid role mapping, calibration, offsets, and published clip recipes. |
| 12 | Relative original paths and local FBX material-map assignments. |

The reader accepts schemas 1 through 12. Older archives without texture assignments continue to use the local path and unique basename resolver. The next save writes schema 12. A future schema is refused before replacing the open project. Reopen uses the archived originals and working state, requires no Tripo or Meshy connection, and starts a new Undo history.

## Resource and engine limits

- Model inputs have a 160 MiB aggregate limit. FBX ZIP entries are capped at 128 MiB each and 256 MiB expanded overall, with at most 256 entries. Projects have a 512 MiB limit. Invalid or duplicate archive paths are refused.
- Texture editing supports maps through 4096 × 4096. The direct UV tool can bake through 4096 × 4096. Spatial projection is capped at 2048 × 2048.
- The diagnostic texture estimate counts four bytes per decoded texel. Mipmaps, source snapshots, Undo, GPU copies and worker buffers add to peak use.
- The mesh scan highlights a sample for each finding. Coincident points, open borders, out-of-range UVs and mirrored winding can be intentional. The coarse UV overlap scan is advisory. Bake performs its own coverage checks. The optional self-intersection scan applies a comparison budget.
- Unity 2022.3.62f2 and 6000.3.9f1 are the tested FBX importers. GLB uses an independent glTF reader and the Khronos validator. See the acceptance report for the test settings and measured limits.

[Full acceptance and references](E12_Report.md) · [Technical specification](AssetFixer_Technical_Specification_v1.0.md)
