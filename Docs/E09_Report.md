# E09 Rig and Manual Pose

E09 covers working rest edits, shared skin binding, and manual posing for imported FBX and GLB models. It implements the E09 stage in the [technical specification](AssetFixer_Technical_Specification_v1.0.md#sec-16), including AT-21, AT-22, AT-26, and the pose portion of AT-27.

## Implementation

- **Working rest.** Stable joint IDs drive viewport and hierarchy selection, local axes, explicit mirror pairs, and both descendant modes. Rename preserves the joint ID and remaps animation tracks. Add creates an unweighted child. Delete transfers influences to a selected joint and keeps surviving children in place. Reparent checks for cycles and can keep world transforms or preserve local transforms. All edits support Undo and Redo.
- **Shared binding.** Bind transforms come from the skin matrices. The adapter updates every affected mesh in one command. The per-mesh transform from mesh space into bone space is `inverse(jointWorldAtBind) × meshWorldAtBind`. FBX raw control-point weights are used when rebuilding the palette. The original imported rig, binding, and clip data remain in the source resources.
- **Manual pose.** The viewport applies temporary local quaternion offsets, then restores the rest transforms after sampling. The rotation gizmo and numeric offsets use local or world axes. Named poses support quick load, rename, duplication, deletion, and missing-joint diagnostics. An ordered list of joint IDs drives finger curling and the one-joint-at-a-time sweep. Project schema 9 stores the working rig, current pose, named poses, and adaptation settings. Earlier project schemas still open.
- **Clip compatibility.** Rest or hierarchy changes flag dependent original clips and invalidate earlier adaptations. Export requires a compatible original, a separately named adaptation, or explicit exclusion for each affected clip. The basic adaptation transfers local position and quaternion motion relative to the rest transforms, with optional manual rotation offsets. The original skeleton overlay can sample the original clip at the same preview time.

## Verification

Tests ran on the Windows workstation with Chrome 158.0.8127.37 using SwiftShader, Unity 2022.3.62f2 and 6000.3.9f1, ufbx at `fcc5d6b`, and the Khronos glTF Validator `2.0.0-dev.3.10`.

Release, Debug, and the E01–E08 browser regressions passed. The E01 run included autosave and recovery of the 250,000-triangle F18 paint fixture.

| Case | Result |
| --- | --- |
| F10 shared FBX, Move Joint and Undo (AT-21) | The synthetic body and clothing share three bones, with 76 and 48 triangles respectively. Both Unity versions and ufbx measured a 0.12 m displacement of `Spine` and zero displacement of `Chest` in Preserve mode. Base points, UVs, and weights matched. ufbx measured zero bind matrix error for both meshes. Undo restored the original matrices and weights. |
| F10 clip and hierarchy (AT-26) | The app blocked export after the rest change and flagged the adaptation after a subsequent change. Both Unity versions and ufbx sampled 21 frames of `SharedTorsoBend_Adapted_1` and confirmed deformation on both meshes. After rename, the original clip name and duration survived and the maximum sampled vertex delta from the source clip was 2.82 × 10⁻⁷ m in Unity and 3.39 × 10⁻⁸ m in ufbx. Deleting `Spine` transferred its weights to `Pelvis`. Both consumers read the surviving shared rig and the explicitly excluded clip was absent. |
| Tripo GLB, mirror and manual pose (AT-22) | The local character has 17,623 triangles and 67 joints. An independent binary reader matched all vertex accessors, triangle indices, joint hierarchy, and both embedded images. The mirrored upper-arm pair differed from exact symmetry by less than 10⁻¹⁵ m. The maximum weighted bind position error was 1.03 × 10⁻⁷ m. Exports with the 30° manual preview and after Reset Pose were byte-identical. The Khronos validator reported zero errors and three warnings on the export. |
| Pose archive (AT-27) | The browser reopened a self-contained FBX project and recovered the joint edit, saved pose, and current quaternion. Rename, duplicate, quick load, reset, curl, sweep, and missing-joint reporting passed. Viewport selection, rest-axis rotation, both descendant modes, cycle checks, and Undo/Redo passed. The E09 run logged zero external requests and zero script errors. |

The validator warnings cover skinned-node placement and transforms and generated tangent space. It also reports an informational message for Tripo's private polygon extension. The input GLB had 22 inverse bind matrix errors from float rounding. The existing importer corrects the affine row.

The Tripo character is a workstation-local asset. Exports, application builds, and test reports are generated locally. The F10 source and its redistribution terms are documented in the [E00 fixture corpus](E00_Corpus.md).

## Reproduction

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/e09-browser.mjs 'C:/Program Files/Google/Chrome/Application/chrome.exe'
python tools/e09-verify.py
python tools/e09-verify.py --unity 2022.3.62f2
python tools/e09-verify.py --unity 6000.3.9f1
node tools/e00/validate-glb.mjs 'D:/downloads/Tripo/man character 3d model.glb' test-results/e09/tripo-reset.glb
```

Run `E09Probe.Run` with `-batchmode -nographics -quit -executeMethod E09Probe.Run` in each generated Unity project. Compile `tools/e00/inspect_fbx.c` with the pinned ufbx. Compare the source FBX with the corresponding extracted exports using `--shared-skin` for Undo and `--rig-moved`, `--rig-renamed`, and `--rig-deleted` for the edited cases. The outputs are under `test-results/e09`.

## Limits

- Rest editing requires decomposable joint transforms and consistent shared bind matrices. Non-bone objects attached to joints require their own transform handling. Imported rig roots keep their original scene attachment.
- Basic clip adaptation supports unchanged ancestry for animated joints and full local position and quaternion tracks. Clips with incompatible hierarchy, unresolved transform bindings, or cubic or partial transform tracks require retargeting before export. E11 covers humanoid mapping, calibration, and diagnostic motion. E10 covers weight painting and per-vertex weight editing.
