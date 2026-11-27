"""Assemble Unity fixtures from the projects exported after E01 recovery."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


def main(version):
    output = Path("test-results/e01")
    source = Path(__file__).parent / "e00"
    project = output / f"unity-{version}"
    fixtures = project / "Assets/Fixtures"
    for case, original, restored in [
        ("static-restored", output / "static-before-restart.zip", output / "static-restored.zip"),
        ("shared-skin", source / "fixtures/shared_skin.fbx", output / "animated-restored.zip"),
    ]:
        copy_bundle(original, fixtures / case / "original")
        copy_bundle(restored, fixtures / case / "exported")
    editors = project / "Assets/Editor"
    editors.mkdir(parents=True, exist_ok=True)
    for script in [source / "FbxProbe.cs", source / "SharedSkinProbe.cs", Path(__file__).with_name("E01Probe.cs")]:
        copy2(script, editors)
    for path, contents in {
        "ProjectSettings/ProjectVersion.txt": f"m_EditorVersion: {version}\n",
        "Packages/manifest.json": json.dumps({"dependencies": {f"com.unity.modules.{name}": "1.0.0"
            for name in ("animation", "imageconversion", "jsonserialize")}}),
    }.items():
        target = project / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    main(argv[1])
