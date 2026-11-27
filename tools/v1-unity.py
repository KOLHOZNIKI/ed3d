"""Prepare independent Unity projects for the selected skinned FBX export."""

from pathlib import Path
from shutil import copy2
from sys import argv
import json

from e00.fixtures import copy_bundle


for version in argv[1:]:
    root = Path('test-results/v1') / f'unity-{version}'
    fixture = root / 'Assets/Fixtures/shared-skin'
    copy_bundle(Path('tools/e00/fixtures/shared_skin.fbx'), fixture / 'original')
    copy_bundle(Path('test-results/v1/chrome/skinned-selection.zip'), fixture / 'exported')
    for folder in ('Assets/Editor', 'ProjectSettings', 'Packages'):
        (root / folder).mkdir(parents=True, exist_ok=True)
    copy2('tools/e00/SharedSkinProbe.cs', root / 'Assets/Editor/SharedSkinProbe.cs')
    (root / 'ProjectSettings/ProjectVersion.txt').write_text(f'm_EditorVersion: {version}\n', encoding='utf-8')
    modules = {f'com.unity.modules.{name}': '1.0.0' for name in ('animation', 'jsonserialize')}
    (root / 'Packages/manifest.json').write_text(json.dumps({'dependencies': modules}), encoding='utf-8')
    print(root.resolve())
