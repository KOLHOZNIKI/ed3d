"""Prepare the static and skinned Soft Selection exports for the Unity importer probe."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


for version in argv[1:]:
    output = Path("test-results/soft-selection")
    project = output / f"unity-{version}"
    fixtures = project / "Assets/Fixtures"
    for kind, fixture, source in (
        ("static", "seams-soft-selection", Path("tools/e00/fixtures/topology_seams.zip")),
        ("skinned", "elbow-soft-selection", Path("test-results/e03/paint_elbow.zip")),
    ):
        copy_bundle(source, fixtures / fixture / "original")
        copy_bundle(output / f"{kind}.zip", fixtures / fixture / "exported")
    for folder in ("Assets/Editor", "ProjectSettings", "Packages"):
        (project / folder).mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("e00") / "FbxProbe.cs", project / "Assets/Editor/FbxProbe.cs")
    (project / "ProjectSettings/ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (project / "Packages/manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())
