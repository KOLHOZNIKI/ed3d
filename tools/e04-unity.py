"""Assemble the Unity and ufbx fixtures for E04 mesh edits."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


def main(version):
    tools = Path(__file__).parent
    out = Path("test-results/e04")
    project = out / f"unity-{version}"
    fixtures = {
        "seams-e04-source": tools / "e00/fixtures/topology_seams.zip",
        "seams-e04-moved": out / "seam-moved.zip",
        "seams-e04-split": out / "seam-split.zip",
        "seams-e04-undo": out / "split-undone.zip",
        "holes-filled": out / "holes-filled.zip",
        "skin-source": Path("test-results/e03/paint_elbow.zip"),
        "skin-split": out / "elbow-split.zip",
        "skin-separated": out / "elbow-separated.zip",
    }
    for label, source in fixtures.items():
        copy_bundle(source, project / "Assets/Fixtures" / label)
    editor = project / "Assets/Editor"
    editor.mkdir(parents=True, exist_ok=True)
    for script in (tools / "e00/FbxProbe.cs", tools / "E04Probe.cs"):
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
