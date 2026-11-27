# E11 Humanoid Diagnostics

E11 implements the humanoid tests in [§18 of the technical specification](AssetFixer_Technical_Specification_v1.0.md#sec-18), including AT-25 and the frozen Squat workflow in §18.6.

## Implementation

- **Mapping.** Joint names and hierarchy produce suggestions with confidence estimates. Roles are editable and store stable joint IDs. The mapping lists missing, duplicate and misparented joints. Each motion checks its own role requirements. A supported subset is labeled as a partial check. Extra joints, including intermediate twist and finger joints, remain in the rig.
- **Calibration.** The reference comes from an aligned T/A pose or a captured manual pose. Bone directions and the reference landmarks determine the motion axes. Foot and toe landmarks resolve the forward direction where available. A manual forward toggle and local axis adjustments let the artist refine the calibration. The profile stores arm abduction, leg spacing and a three-axis pelvis offset in scene units. The viewport can overlay the uncorrected skeleton at the same time as the corrected motion.
- **Offline motions.** Idle, Walk, Run, Jump, Squat, Sit, Wave, Punch, Bend and Reach, and Torso Twist are original procedural motions authored in this repository. Diagnostic export samples them at approximately 30 frames per second. Presets cover working rest, T/A, Arms Up, 90° elbows, Squat, Wide Stance, Knee Raised and Torso Bend. Saved checkpoints retain local rotations and translations relative to the working rest.
- **Player.** Playback supports pause, looping, scrubbing, stepping, four speed presets, custom speed, and a repeat range. In-place playback is the default. Root motion is available for authored diagnostic travel and recognizable translation tracks on imported rig roots. The player can show the skeleton, unlit materials or a weight heatmap. Clip changes preserve the camera. Weight Paint receives the exact sampled clip and timestamp. Returning to the player restores its selected clip and range.
- **Exports and projects.** Schema 11 stores the calibration, mapping, offsets, named poses and published diagnostic recipes. Previous project schemas remain readable. A recipe retains the settings used at publication, and a later rig-basis change marks it stale. Published clips are attached during export. Imported clip disposition continues to use the rig compatibility rules. An explicit adaptation can include a saved pose's local rotation and translation offsets.

## Verification

Tests used Chrome 158.0.8127.37 with SwiftShader, Unity 2022.3.62f2 and 6000.3.9f1, ufbx at `fcc5d6b`, and the Khronos glTF Validator `2.0.0-dev.3.10` on the Windows workstation. Release, Debug and the E01–E10 browser regressions passed. The E08 static FBX repair and projection outputs also passed Unity 2022.3 and ufbx reimport checks.

| Case | Result |
| --- | --- |
| AT-25 offline mapping and poses | All ten motions ran on the 67-joint Tripo GLB and on the 25-joint synthetic FBX. The three-joint F10 rig offered two partial checks. Manually duplicating a role produced a diagnostic. Restoring the role recovered all ten. Reopening the Tripo project restored its A-pose reference, local axis correction, offsets, published clips and a named Squat checkpoint, including pelvis translation. No external requests, script errors or unresolved animation bindings were observed. |
| Frozen Squat and replay | The FBX player handed off the 1.200 s frame to Weight Paint. One masked Replace stroke edited three control points. Returning to the player restored the frame and the 0.90–1.45 s repeat range. ufbx verified the three affected rows and Unity imported five corresponding render vertices with the expected weights. |
| FBX clip round-trip | The original `SourceStep` and all ten published diagnostics were present. Unity and ufbx sampled 21 frames per clip and confirmed deformation. Unity's largest vertex prediction error was 4.30 × 10⁻⁷ m. Squat lowered the pelvis by approximately 0.405 m and applied the configured 0.035 m starting offset. Walk traveled 1.074 m and Run stayed in place. The original clip retained its 0.44 m travel. Base positions, UVs, bind matrices, and the intermediate arm joints matched. Exporting an unpublished Squat frame preserved the source bind and original animation. |
| GLB comparison and export | Exporting in working rest and from the unpublished Squat preview produced identical bytes. The publication contained only the two selected diagnostic clips. The independent reader matched skinned attributes, triangle indices, images, joint hierarchy, base transforms and inverse binds. Corrected Squat lowered the pelvis by 0.159 m in the fitted frame. Walk traveled 0.421 m perpendicular to the fitted up axis. The validator reported zero errors and the same three warnings as the baseline export. |
| Clip versions and overlays | Baseline and corrected diagnostics produced different previews. The player overlaid both skeletons and compared an adapted imported clip with its original. An explicitly adapted clip captured the saved pose translation. A rest edit invalidated the old calibration and blocked export of the stale published recipes. |

The synthetic FBX and the diagnostic motions are authored by this project under the repository license. `tools/e11-fixture.mjs` generates the FBX locally. The Tripo character stays outside Git. The [E00 fixture corpus](E00_Corpus.md) records the F10 source.

## Reproduction

```powershell
npm.cmd run build
npm.cmd run build:debug
node tools/e11-fixture.mjs
node tools/e11-browser.mjs 'C:/Program Files/Google/Chrome/Application/chrome.exe'
python tools/e11-verify.py
python tools/e11-verify.py --unity 2022.3.62f2
python tools/e11-verify.py --unity 6000.3.9f1
node tools/e00/validate-glb.mjs test-results/e11/tripo-rest.glb test-results/e11/tripo-published.glb
```

Run `E11Probe.Run` in each generated Unity project with `-batchmode -nographics -quit -executeMethod E11Probe.Run`. Compile `tools/e11-fbx.c` with the pinned ufbx and pass the original, preview export and published export. The Unity setup extracts these FBX files under `Assets/Fixtures`. Reports and browser screenshots are under `test-results/e11`.

## Limits

- The motions target deformation review. Foot contact, collision avoidance, and automatic correction of unusual proportions are outside the procedural solver. The fitted axes and offsets remain artist-adjustable.
- Unity verification uses Generic animation. Unity Humanoid Avatar creation and broad retargeting of arbitrary imported hierarchies are outside this implementation. Existing imported-clip adaptation retains the E09 compatibility restrictions.
- Playback position and repeat range persist during the current session. Save a named checkpoint for a frame that must survive reopening.
