"""Prepare independent Unity projects for the V1 FBX exports."""

from pathlib import Path
from shutil import copy2
from sys import argv
import json

from e00.fixtures import copy_bundle


external_png = '--external-png' in argv
for version in (arg for arg in argv[1:] if arg != '--external-png'):
    root = Path('test-results/v1') / (f'unity-png-{version}' if external_png else f'unity-{version}')
    if external_png:
        for case, source, export in (
            ('static', 'ceramic plate 3d model.zip', 'plate-external-png.zip'),
            ('skinned', 'tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip', 'character-external-png.zip'),
        ):
            fixture = root / 'Assets/Fixtures' / case
            copy_bundle(Path('D:/downloads/Tripo') / source, fixture / 'original')
            copy_bundle(Path('test-results/v1/chrome') / export, fixture / 'exported')
        fixture = root / 'Assets/Fixtures/authored'
        copy_bundle(Path('test-results/e00/ufbx/data/maya_kenney_character_7700_binary.fbx'), fixture / 'original')
        copy_bundle(Path('test-results/v1/chrome/authored-current.fbx'), fixture / 'exported')
        script = 'FbxProbe.cs'
    else:
        fixture = root / 'Assets/Fixtures/shared-skin'
        copy_bundle(Path('tools/e00/fixtures/shared_skin.fbx'), fixture / 'original')
        copy_bundle(Path('test-results/v1/chrome/skinned-selection.zip'), fixture / 'exported')
        script = 'SharedSkinProbe.cs'
    for folder in ('Assets/Editor', 'ProjectSettings', 'Packages'):
        (root / folder).mkdir(parents=True, exist_ok=True)
    copy2(Path('tools/e00') / script, root / 'Assets/Editor' / script)
    (root / 'ProjectSettings/ProjectVersion.txt').write_text(f'm_EditorVersion: {version}\n', encoding='utf-8')
    modules = {f'com.unity.modules.{name}': '1.0.0' for name in ('animation', 'jsonserialize')}
    (root / 'Packages/manifest.json').write_text(json.dumps({'dependencies': modules}), encoding='utf-8')
    print(root.resolve())
