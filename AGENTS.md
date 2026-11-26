# Project instructions

## Git workflow

- Before starting each task, inspect `git status --short --branch` and run `git pull --ff-only` on the current branch. Preserve existing changes. If the pull fails, report the blocker and avoid rewriting history.
- When a task changes the repository, run the relevant checks, review the diff, stage only task-related files, commit them, and push the commit to the branch's upstream. Verify the push and report any checks or Git operations that could not be completed.
- Use concise English commit messages. Keep each commit focused on the task. Preserve unrelated changes and avoid force-pushing.

## Project scope and architecture

- Follow the AssetFixer technical specification in `Docs/AssetFixer_Technical_Specification_v1.0.md` and the acceptance criteria for the current stage. Start development with E00 and use its prototype results to choose format and geometry backends.
- Use strict TypeScript, Vite, and Three.js with WebGL2 as the baseline. Process assets locally. Pin dependencies with a lockfile and bundle required decoders and WASM assets locally.
- Keep the working document as the source of truth. Keep topology and stable element IDs independent of Three.js render buffers. Preserve source files and explicitly track resource ownership.
- Route document edits through validated, undoable commands. For background jobs, validate the result and its source revision before committing it. Use a snapshot of the current painted state by default when preparing a UV rebake.
- Preserve supported geometry, materials, UVs, weights, and animation data across edits and export. Report unsupported data or required conversions before export. Verify FBX round-trips for both static and skinned assets in Unity and with an independent parser.

## Documentation and verification

- Write documentation and code comments in English. Use comments to explain invariants and decisions that are hard to infer from the code.
- Verify changes through the affected workflow. For format and geometry changes, use representative fixtures and check exported data against the relevant acceptance criteria. Record the test environment and known limitations when they affect the result.
- Keep package lockfiles and curated asset fixtures in version control. Record fixture sources and redistribution permissions. Keep local settings, caches, and generated output out of commits.
