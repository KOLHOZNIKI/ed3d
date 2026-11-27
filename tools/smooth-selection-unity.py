"""Prepare the independent Unity checks for the static and skinned smoothing fixtures."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


for version in argv[1:]:
    results = Path("test-results/smooth-selection")
    project = results / f"unity-{version}"
    for kind in ("static", "skinned"):
        fixture = project / "Assets/Fixtures" / f"smooth-selection-{kind}"
        copy_bundle(Path("test-results/e03") / f"smooth_selection_{kind}.zip", fixture / "original")
        copy_bundle(results / f"{kind}.zip", fixture / "exported")
        (fixture / "position-edit.json").write_text(json.dumps({"offsetY": -.375, "minimumUvCopies": 1}), encoding="utf-8")
    for folder in ("Assets/Editor", "ProjectSettings", "Packages"):
        (project / folder).mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("e00") / "FbxProbe.cs", project / "Assets/Editor/FbxProbe.cs")
    (project / "ProjectSettings/ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{m}": "1.0.0" for m in ("animation", "jsonserialize")}
    (project / "Packages/manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())
