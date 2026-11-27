# E01 working document and project recovery

## Implemented scope

E01 opens a supported FBX ZIP, a binary FBX with selected maps, or a self-contained GLB as a working document. The document owns the original bytes, a scene hierarchy, stable object and source element IDs, per-corner attributes, polygon adjacency and triangle provenance. FBX control points and polygon corners remain distinct through UV splits. GLB uses its authored vertex indices, including coincident independent points. An edge can reference every incident face. The pinned E00 readers rebuild the original rig, material and animation data. The viewer uses separate resources for its temporary baked appearance. [Core and project specification](AssetFixer_Technical_Specification_v1.0.md#sec-05) · [E00 format limits](E00_Report.md)

The viewport supports object selection by list or ray hit, orbit, pan, zoom, framing, axis views and perspective or orthographic projection. View navigation stays outside edit history. Project labels, viewport visibility, UV atlas generation, rebake, paint and discard operations are validated revision changes with Undo and Redo. Cancelling a running worker terminates it and leaves the previous state intact. The editor warns before closing or replacing a dirty project. Project labels and viewport visibility are editor data. FBX and GLB export use the source names and complete scene.

### Archive and autosave

`.assetfixer` is a ZIP with `manifest.json` and content-addressed `blobs/<SHA-256>` entries. The manifest records the version, project ID, revision, settings, original filenames, scene IDs and hierarchy, and references to working atlas data and PNGs. Binary atlas arrays are little-endian. Identical content shares a ZIP entry. On open, the reader verifies size limits, safe ZIP paths, required references and SHA-256, then matches the saved hierarchy and atlas correspondence to the embedded originals. The archive limit is 512 MiB. The source format keeps the existing 160 MiB input limit.

Schema 2 writes the history budget. Schema 1 restores the same working resources with a default 256 MiB budget, and subsequent saves write schema 2. Unknown newer schemas produce an explicit error. **Save Project** downloads the current document. **Save As** gives the copy a separate project ID. A reopened project restores the current work and starts a new Undo/Redo history.

E02 retains the schema 1 and 2 readers and writes schema 3 for working texture resources. [E02 texture persistence](E02_Report.md)

IndexedDB stores up to three committed checkpoints for the browser origin and profile. The five-second timer starts after a commit. A stroke or active transaction defers capture until it has completed. The database adds the checkpoint and prunes the older ones atomically. On startup the application verifies the archives and offers the latest intact revision. A storage error keeps the working document and the prior checkpoints available. **Save Project** remains available for a file backup. [Saving and recovery requirements](AssetFixer_Technical_Specification_v1.0.md#sec-06)

## Verification

| Check | Result |
| --- | --- |
| Save, restart, reopen and export offline | A painted static FBX, an animated shared-skeleton FBX and a compressed Meshy GLB reopened in fresh Chrome processes from `.assetfixer` files after the temporary originals were removed. The app loaded from localhost before switching offline. It recorded zero HTTP requests during reopening and export. |
| F18 heavy recovery | Eight strokes, two Undo operations and one Redo left seven strokes on the 250,000-triangle model with a 4K input map. Chrome recovered revision 13 from IndexedDB after restart. The PNG and atlas corner map matched the pre-restart export byte for byte. |
| Working edits and stable IDs | The static project restored its label, viewport state, atlas and painted PNG. Its object and first-face IDs remained stable. Undo and Redo restored the earlier object state and the exact painted PNG. The saved original matched its source SHA-256. |
| Autosave and controlled failure | The browser skipped a deliberately damaged newer checkpoint and restored the earlier intact revision. Simulated quota exhaustion left the new edit available for download. A bad content hash and an unknown schema left the open project unchanged. Schema 1 opened and saved as schema 2. Save As generated a separate project ID. |
| Viewer and workers | Orthographic and axis views left the document revision unchanged. Cancelling atlas generation preserved the prior revision. The dirty-close prompt kept the project open when dismissed. `WEBGL_lose_context` restored the preview and the exact painted texture survived export. |
| Unity 2022.3.62f2 and 6000.3.9f1 | The restored static export matched all four triangles, eight imported vertices, normals, both UV sets and the linked Base Color PNG. Body and clothing retained the shared three-bone rig, exact weights, exact bind matrices and the one-second clip. The maximum world-space deformation difference over 21 samples was `2.82e-7 m`. |
| Independent asset readers | ufbx verified original connectivity, corner attributes, mapped atlas and all skin weights. The shared avatar's maximum sampled deformation difference was `3.39e-8 m`. glTF Transform matched 19,274 positions, normals and UVs, 28,069 triangles and the three exact WebP payloads. The Khronos validator found zero errors and the original tangent-space warning. |
| Release, Debug and adapter regressions | Both builds passed. F15 brush and projection still isolated the two surfaces. The Tripo plate stroke crossed both atlas seams and Undo restored the exact PNG. The Tripo character retained its four-map rebake profile. |

The E01 command history caps retained working buffers at the configured budget. The inherited E00 brush still produces a compressed PNG snapshot per committed stroke. Tile-based image history, the broader mesh tools and their correspondence updates belong to the later editing stages. The autosave database is scoped to one browser origin and profile. Save a project file for transfer between the Release and Debug server ports or between machines. [Stage plan](AssetFixer_Technical_Specification_v1.0.md#sec-21)

E01 evidence covers PROJECT-01 and PROJECT-02, the topology foundations of CORE-01/02/03/05/06, and HIST-01/03/05/07 for the exposed commands. AT-27 covers the available working assets. The run exercises cancellation for AT-28, WebGL restoration for AT-29 and the storage-quota case for AT-30. The later workflows add independently editable poses, tile history and general topology changes. [Acceptance tests](AssetFixer_Technical_Specification_v1.0.md#sec-22)

## Reproduce on Windows

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd install --prefix test-results/e00-browser --save-exact playwright-core@1.65.1
npm.cmd run build
npm.cmd run build:debug
node tools/e01-browser.mjs $chrome
$version = '2022.3.62f2'
$project = python -B tools/e01-unity.py $version
$editor = "C:/Program Files/Unity/Hub/Editor/$version/Editor/Unity.exe"
$log = Join-Path $project 'e01-unity.log'
$argsUnity = @('-batchmode', '-nographics', '-quit', '-projectPath', ('"' + $project + '"'),
  '-executeMethod', 'E01Probe.Run', '-logFile', ('"' + $log + '"'))
$unity = Start-Process -FilePath $editor -ArgumentList $argsUnity -WindowStyle Hidden -PassThru
$unity.WaitForExit()
if ($unity.ExitCode -ne 0) { throw "Unity E01 verification failed. See $log" }
```

To include F18, run `node tools/e00/memory-fixture.mjs --heavy-paint` and pass `test-results/e00/memory/f18_paint.zip` after the Chrome path in the browser command. It also writes `f18.assetfixer` and `f18-recovered.zip`. [F18 workload](E00_F18.md)

The browser writes `browser-report.json`, the three `.assetfixer` reference files and the restored asset exports under `test-results/e01/`. Unity writes `e01-static-report.json` and `shared-skin-report.json` inside its generated project. The Unity probe uses Generic rigs, imported normals, MikkTSpace tangents, standard skin weights, file scale and disabled mesh and animation compression. Set `$version` to `6000.3.9f1` to repeat the Unity 6 run. The project fixtures are drawn from the tracked F10, F15 and F17 corpus. [Static fixture](E00_F15.md) · [Shared skin](E00_F10.md) · [Compressed GLB](E00_F17.md)

Use `inspect_fbx --baked` on the static and F18 FBXs and their respective `uv-atlas-source-corners.bin`, and `inspect_fbx --shared-skin` on the animated export. Use `node tools/e00/inspect_f17.mjs tools/e00/fixtures/meshy-gambit-pawn-lo.glb test-results/e01/meshy-restored.glb` to compare the Meshy export. [Native reader setup](E00_FBX_Round_Trip.md#reproduce-on-windows) · [GLB inspection setup](E00_F17.md#reproduce-on-windows)
