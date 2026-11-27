# E10 Weight Editing

E10 implements the weight editor in [§17 of the technical specification](AssetFixer_Technical_Specification_v1.0.md#sec-17), including AT-23 and AT-24. It reuses the rest, manual pose, and original or adapted clips from E09.

## Implementation

- **Stable weights.** Weight edits record logical vertex and joint IDs in the project's mesh command log. They run in order with geometry edits, so a split or fill can interpolate the current weights. FBX polygon corners share the control-point row across UV seams. A weight-only edit preserves the raw polygon and corner data. Project schema 10 stores the weight log and influence locks. Earlier schemas remain readable.
- **Frozen brush.** Add, Subtract, Replace, and Smooth use a screen-space radius, strength, falloff, front-only or X-ray visibility, and an optional face mask. The viewport captures the posed surface and holds the correspondence for the stroke. A vertex receives the maximum coverage reached during the stroke. Smooth uses the pre-stroke weights of edge-connected neighbors. A stroke commits as one Undo command.
- **Exact editing and limits.** Numeric edits and Normalize preserve locked values. The report highlights invalid rows, including zero sums. A zero sum needs an explicitly selected destination or valid source weights. A fifth influence rejects the whole stroke by default. The operator can choose a particular replacement or explicit limiting. Wide FBX rows retain their full weights and show a four-weight preview. Conversion previews the changed mesh and reports discarded weight mass and the peak deviation from full skinning at the selected pose.
- **Mirror and transfer.** Mirror uses reciprocal, unambiguous vertex matches in world space and an explicit table of joint pairs. Transfer samples a named source mesh from the original import or a captured working revision. It interpolates weights from a source triangle, constrains candidates by distance, normal direction and optional face selection, and maps influences by stable IDs or explicit pairs. Both operations report and highlight vertices they skip.

## Verification

The checks used Chrome 158.0.8127.37 with SwiftShader, Unity 2022.3.62f2 and 6000.3.9f1, ufbx at `fcc5d6b`, and the Khronos glTF Validator `2.0.0-dev.3.10` on the Windows workstation. The browser test recorded zero external requests and zero script errors.

Release, Debug, and the E01–E09 browser regressions passed. E01 included autosave and recovery of the 250,000-triangle project. The E08 static FBX repair and projection outputs also passed reimport checks in Unity 2022.3 and ufbx.

| Case | Result |
| --- | --- |
| AT-23, rejecting a fifth influence | An Add stroke at a four-influence F13 vertex highlighted logical vertex `0` and preserved the project revision. F11 separately rejected replacement of a locked influence, then accepted explicit replacement of an unlocked influence. The independent GLB parser found a change only at vertex `24`, preserved `Pelvis` at `0.21875`, and matched its expected deformed position within 2.29 × 10⁻⁸ m. The GLB validator reported zero errors and one warning for a non-root skinned node. |
| AT-24, smoothing close fingers | A masked Smooth stroke on the frozen `FingerBend` frame changed only control point `4` of the left finger. Its `Palm` weight changed from `0.5` to `0.625`. A wider X-ray stroke included vertices `4` and `7` on the two fingers. ufbx matched weights, base positions, topology, UVs and bind matrices on the narrow-stroke export. |
| UV seam and deformation | Unity imported three render vertices for the edited point across its UV seams. All three remained coincident over 21 samples. The edited point moved by up to 0.01742 m relative to the source clip. All unaffected points matched. The expected deformation from the edited weights matched within 1.20 × 10⁻⁷ m in Unity and 8.05 × 10⁻⁹ m in ufbx. Undo reproduced the original weights and motion. |
| Wide FBX conversion | Preview reported discarded mass of `0.1875` across two vertices and a nonzero change at the frozen bend. ufbx verified the four-influence output, including the exact locked weight and normalized sums, and measured up to 0.01959 m of deformation change. Both Unity versions read back the converted weights within 4.77 × 10⁻⁶ and the predicted positions within 1.21 × 10⁻⁵ m. Undo restored all five influences and the original deformation. |
| Normalization, mirror and transfer | A zero row required a fallback joint. A separate non-unit row normalized to one with its locked `Palm` value still at `0.5`. Mirror copied the named partner's weight through the chosen plane. Barycentric transfer restored the captured source weights after a later edit. Splitting an edge interpolated the edited `Palm` weights `0.5` and `0.625` to `0.5625`. Locks and weight edits survived reopening a project. A joint added in E09 accepted a new weight, survived save and reopen, and transferred its weights when deleted. |

The E10 finger fixtures are synthetic and are generated locally from the checked-in `tools/e10-fixture.mjs`. The F11 torso and F13 wide-skin fixtures are documented in the [E00 fixture corpus](E00_Corpus.md). No external assets are required by the E10 verification.

## Reproduction

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/e10-fixture.mjs
node tools/e10-browser.mjs 'C:/Program Files/Google/Chrome/Application/chrome.exe'
python tools/e10-verify.py
python tools/e10-verify.py --unity 2022.3.62f2
python tools/e10-verify.py --unity 6000.3.9f1
node tools/e00/validate-glb.mjs tools/e00/fixtures/corpus/f11_wide_torso.glb test-results/e10/torso-replaced.glb
```

Run each generated project in its Unity version with `-batchmode -nographics -quit -executeMethod E10Probe.Run`. Compile `tools/e00/inspect_fbx.c` with the pinned ufbx. Use `--weight-stroke` for the edited finger FBX and `--weight-wide` for the converted F13 FBX. Run the same inspector with no mode flag on both Undo exports. Reports are under `test-results/e10`.

## Limits

- FBX morph targets and GLB with secondary joint/weight accessors remain subject to the existing format limits. The editor diagnoses malformed or unresolved influences and blocks operations that would rely on them. Full-weight FBX deformation is evaluated for the comparison at the chosen pose. The interactive renderer uses four influences.
- A GLB may encode coincident vertices as distinct topology. The editor follows the available logical IDs. A face mask includes the logical vertices of its selected faces, including any vertices shared along the mask boundary.
- A working transfer snapshot stays in memory while Weight Paint is open. The resulting edits and locks persist in `.assetfixer`. Animation diagnostics and humanoid mapping belong to E11.
