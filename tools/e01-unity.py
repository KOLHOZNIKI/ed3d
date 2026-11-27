"""Assemble Unity fixtures from the projects exported after E01 recovery."""

import json
from pathlib import Path
from shutil import copy2
from sys import argv

from e00.fixtures import copy_bundle


def main(version, *options):
    output = Path("test-results/e01")
    source = Path(__file__).parent / "e00"
    textures = "--textures" in options
    project = (Path("test-results/e02") if textures else output) / f"unity-{version}"
    fixtures = project / "Assets/Fixtures"
    for case, original, restored in [
        ("static-restored", output / "static-before-restart.zip", output / "static-restored.zip"),
        ("shared-skin", source / "fixtures/shared_skin.fbx", output / "animated-restored.zip"),
    ]:
        copy_bundle(original, fixtures / case / "original")
        copy_bundle(restored, fixtures / case / "exported")
    scripts = [source / "FbxProbe.cs", source / "SharedSkinProbe.cs", Path(__file__).with_name("E01Probe.cs")]
    if textures:
        current = Path("test-results/e02")
        texture_cases = {
            "source": source / "fixtures/f15_source.zip", "raw": current / "raw-edited.zip", "atlas": current / "combined-fbx.zip"
        }
        for case, bundle in texture_cases.items():
            copy_bundle(bundle, fixtures / "e02" / case)
        scripts.append(Path(__file__).with_name("E02Probe.cs"))
        for name in ("alpha.png", "atlas-2d-and-3d.png"):
            copy2(current / name, project)
    editors = project / "Assets/Editor"
    editors.mkdir(parents=True, exist_ok=True)
    for script in scripts:
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
    main(*argv[1:])
