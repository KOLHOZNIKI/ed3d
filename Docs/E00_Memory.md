# E00 typical model memory on Windows

## Workload and setup

The project-generated FBX ZIP contains one connected skinned mesh with 50,000 triangles, 25,326 control points, 100 weighted bones, and four 2048 × 2048 PNGs for Base Color, Normal, Roughness, and Metallic. Each point has three nonzero weights. The mesh has a single UV chart and no animation. The ZIP used for the recorded run is 18,360,926 bytes with SHA-256 `679f871577b0dd20d4eccad71a77919f089e1df2672d8fe8840f7cd8515db884`. Regeneration reproduces the workload with newly generated FBX object IDs and ZIP timestamps. The Tripo character is a separate real-world comparison with 17,623 triangles, 67 bones, four maps and 511 charts after repacking. Its local source and checksum are recorded in the [E00 report](E00_Report.md#fixture-provenance).

The benchmark used Windows 11 Pro build 26300, AMD Ryzen 9 9950X3D (16 cores, 32 threads), 61.58 GiB of usable physical RAM, and Chrome 158.0.8127.37. The WebGL2 renderer used the NVIDIA GeForce RTX 3070 through ANGLE D3D11 with driver 32.0.16.2124. The production build used a 1920 × 1080 drawing buffer at DPR 1 in a dedicated headless Chrome instance. The fixture runs in separate browser instances.

## Measurement method

Each cycle opens the ZIP through the file picker, generates UV1, rebakes the four textures, waits for the exported FBX ZIP to download, and clicks **Close model**. The tab and WebGL context stay open. The sampler requests one Windows measurement every 20 ms. It sums private committed bytes and working-set bytes across the isolated Chrome process tree, including renderer and GPU processes. The working-set sum can count shared resident pages more than once. These are CPU-side process figures. Dedicated GPU VRAM and peaks between samples are outside the measurement. The harness, fixture generator, and sampler run outside the measured process tree. [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information)

The phase results are the highest observed samples within each action. Import includes the browser file picker automation and the first render. Export includes ZIP creation and download completion. The harness waits 2.5 seconds after each close before recording process memory, the page's V8 heap and backing storage, DOM counters, and active workers. It forces a collection before the empty baseline and once after the final natural observation to show what remains reachable. Intermediate cycles use the browser's automatic GC. [Chrome heap counters](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage) · [Chrome GC command](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage)

## Typical-profile results

Eight cycles processed all 50,000 triangles and 100 bones on every import. xatlas generated one chart at 787 × 1035. Rebake produced four maps at 1574 × 2070. All downloads and closes completed with zero active workers after each close. The Windows sampler measured every discovered process in all 2,622 samples. The median sample interval was 30 ms and the largest gap was 49 ms.

| Phase | Peak private commit, MiB | Peak summed working set, MiB | Duration range, s |
| --- | ---: | ---: | ---: |
| Import | 1,556 | 1,293 | 0.275–0.410 |
| UV unwrap | 1,538 | 1,299 | 0.294–0.379 |
| Rebake four maps | 1,607 | 1,379 | 1.763–2.159 |
| Export FBX ZIP | 1,420 | 1,208 | 0.348–0.444 |

Each column gives its own maximum across all eight cycles. The largest private peak was 1.57 GiB total for Chrome, or 1.21 GiB above the empty-tab baseline.

| Observation | Private commit, MiB | Summed working set, MiB | Page V8 heap used, MiB | Page backing storage, MiB |
| --- | ---: | ---: | ---: | ---: |
| Empty baseline | 368 | 461 | 3.7 | 1.1 |
| After close 1 | 973 | 998 | 20.9 | 84.1 |
| After close 2 | 1,153 | 1,051 | 21.1 | 83.0 |
| After close 3 | 1,152 | 1,002 | 17.4 | 108.2 |
| After close 4 | 1,321 | 1,117 | 21.3 | 83.0 |
| After close 5 | 1,271 | 1,062 | 17.7 | 108.2 |
| After close 6 | 1,352 | 1,163 | 21.6 | 83.0 |
| After close 7 | 1,351 | 1,169 | 21.7 | 83.5 |
| After close 8 | 1,365 | 1,206 | 21.5 | 83.0 |
| After diagnostic GC | 1,038 | 985 | 6.2 | 9.1 |
| After 20 more seconds idle | 736 | 869 | 6.2 | 9.1 |

The final three natural closes were within 15 MiB of one another. After diagnostic GC and idle, private commit fell by 629 MiB from the last close and stayed 368 MiB above the empty baseline. The Chrome GPU process accounted for approximately 219 MiB of that remaining private commit above baseline, and the active page renderer for approximately 143 MiB. The counters attribute memory to processes. Classifying individual browser-native allocations would require allocation traces.

The diagnostic run with the original FBX loader returned to 17.2 MiB page heap used after GC, versus a 3.7 MiB empty baseline. The loader kept its parse tree, connections, and latest scene in module-scope variables. The pinned Three.js patch clears those references when synchronous parsing finishes. With the patch, the eight-cycle run returned to 6.2 MiB after GC. **Close model** also disposes the owned render resources, clears the paint history and atlas, closes owned GLB image bitmaps, and releases references to the model and camera.

## Real Tripo comparison and scope

The Tripo character produced 511 charts at 1414 × 1421 and four rebaked maps at 2828 × 2842. It reached 1,785 MiB private commit and 1,906 MiB summed working set during the bake across three cycles. The private peaks for import, unwrap, and export were 1,693 MiB, 1,492 MiB, and 1,558 MiB respectively. At 2.5 seconds after each close, private commit was 1,001, 1,464, and 1,160 MiB. It fell to 1,022 MiB after diagnostic GC and to 972 MiB after the additional idle interval, against a 367 MiB empty baseline. All 1,724 samples covered every discovered process. The larger baked atlas had about 2.47 times the texel count of the synthetic fixture's. The real asset's higher bake peak warrants accounting for the output atlas dimensions when estimating memory.

ufbx verified the final ZIP from each run. Both exports retained all control-point positions, source triangle connectivity through the atlas corner map, original UVs, and exact source skin weights. Every atlas triangle was valid. The four measured phases fit on the recorded workstation. Paint and undo memory, a budget for lower-memory machines, independent GPU VRAM measurements, and the full F18 history and recovery workload remain outside these runs.

The follow-up F18 benchmark records memory during a longer brush and Undo sequence and a four-map heavy workload on a 250,000-triangle model. [F18 checkpoints and measurements](E00_F18.md)

## Reproduce on Windows

Use the [pinned browser probe setup](E00_FBX_Round_Trip.md#reproduce-on-windows), locally installed Chrome and Python. Run one benchmark at a time.

```powershell
$chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd ci
npm.cmd run build
node tools/e00/memory-fixture.mjs
node tools/e00/memory-browser.mjs test-results/e00/memory/typical_memory.zip $chrome --cycles 8 --label typical --idle-seconds 20
$tripo = 'D:/downloads/Tripo/tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip'
node tools/e00/memory-browser.mjs $tripo $chrome --cycles 3 --label tripo --idle-seconds 20
```

Reports and the final ZIP of each run are under `test-results/e00/memory/`. The JSON contains byte counts, phase timestamps, fixture and host details, the exported manifest, and the full time series. Each raw sample contains the Unix timestamp in milliseconds, private bytes, working-set bytes, measured process count, discovered process count, and per-process breakdown.
