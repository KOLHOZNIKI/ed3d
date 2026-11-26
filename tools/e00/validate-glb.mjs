import { readFile } from 'node:fs/promises';
import validator from '../../test-results/e00-glb-validator/node_modules/gltf-validator/index.js';

const [original, exported] = process.argv.slice(2);
if (!original || !exported) throw new Error('Usage: node tools/e00/validate-glb.mjs original.glb exported.glb');
const report = {};
for (const [label, path] of [['original', original], ['exported', exported]]) {
  const result = await validator.validateBytes(await readFile(path), { maxIssues: 0 });
  const codes = {};
  for (const { code } of result.issues.messages) codes[code] = (codes[code] ?? 0) + 1;
  report[label] = {
    validator: result.validatorVersion,
    errors: result.issues.numErrors,
    warnings: result.issues.numWarnings,
    codes,
    images: result.info.resources.filter(resource => resource.image).map(resource => resource.image),
  };
}
console.log(JSON.stringify(report, null, 2));
if (report.exported.errors !== 0) process.exitCode = 1;
