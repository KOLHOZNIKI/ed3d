# AssetFixer

AssetFixer is a local browser-based editor for refining generated 3D assets before importing them into Unity. The repository currently contains the development toolchain and a Three.js scene for checking WebGL2.

## Local development

Use an LTS release of Node.js 22.12 or later with npm and a desktop browser with WebGL2. Chrome and Edge on Windows are the primary browser targets.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. A colored cube and the WebGL2 status message confirm that the renderer initialized.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the application with strict TypeScript settings. |
| `npm run build` | Check types and generate the static build in `dist/`. |
| `npm run preview` | Serve the production build locally after building it. |

Install dependencies with `npm ci` so the build uses the versions recorded in `package-lock.json`.

## Dependencies

| Package | License | Purpose |
| --- | --- | --- |
| `three` | MIT | WebGL2 viewport and rendering. |
| `@types/three` | MIT | Type definitions matching the Three.js release. |
| `typescript` | Apache-2.0 | Strict type checking. |
| `vite` | MIT | Local development server and static bundling. |

## First development stage

E00 begins with one static FBX fixture and one skinned FBX fixture with an animation. Record the fixture sources and redistribution permissions. Verify import and export with Unity 2022.3 LTS and an independent FBX reader. The [technical specification](Docs/AssetFixer_Technical_Specification_v1.0.md#sec-21) lists the remaining prototypes and acceptance criteria.
