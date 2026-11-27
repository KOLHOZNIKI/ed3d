"""Assemble the bottle repair verification project."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


def main(version):
    tools = Path(__file__).parent
    results = Path("test-results/e05")
    project = results / f"unity-{version}"
    for name in ("bottle", "bottle-repaired", "skinned-bottle", "skinned-bottle-repaired"):
        copy_bundle(results / f"{name}.zip", project / "Assets/Fixtures" / name)
    editor = project / "Assets/Editor"
    editor.mkdir(parents=True, exist_ok=True)
    for script in (tools / "e00/FbxProbe.cs", tools / "E05Probe.cs"):
        copy2(script, editor)
    for name, data in {
        "ProjectSettings/ProjectVersion.txt": f"m_EditorVersion: {version}\n",
        "Packages/manifest.json": json.dumps({"dependencies": {f"com.unity.modules.{m}": "1.0.0"
            for m in ("animation", "imageconversion", "jsonserialize")}}),
    }.items():
        path = project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    main(*argv[1:])
