"""Assemble the Unity project for the frozen elbow export."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


def main(version):
    results = Path("test-results/e03")
    project = results / f"unity-{version}"
    fixture = project / "Assets/Fixtures/bent-elbow"
    copy_bundle(results / "paint_elbow.zip", fixture / "original")
    copy_bundle(results / "elbow-painted.zip", fixture / "exported")
    editor = project / "Assets/Editor"
    editor.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("e00") / "FbxProbe.cs", editor)
    for name, data in {
        "ProjectSettings/ProjectVersion.txt": f"m_EditorVersion: {version}\n",
        "Packages/manifest.json": json.dumps({"dependencies": {f"com.unity.modules.{module}": "1.0.0"
            for module in ("animation", "imageconversion", "jsonserialize")}}),
    }.items():
        path = project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    main(*argv[1:])
