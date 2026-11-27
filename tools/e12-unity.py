"""Prepare Unity Humanoid acceptance projects using the E11 authoring fixture and V1 export."""

from argparse import ArgumentParser
import json
from pathlib import Path
from shutil import copy2

from e00.fixtures import copy_bundle


def prepare(version, tripo):
    project = Path("test-results/e12") / (f"unity-static-{version}" if tripo else f"unity-{version}")
    assets = project / "Assets"
    if tripo:
        copy_bundle(tripo / "ceramic plate 3d model.zip", assets / "Fixtures/plate/original")
        copy_bundle(Path("test-results/e12/chrome/tripo-plate.zip"), assets / "Fixtures/plate/exported")
        probe = Path(__file__).parent / "e00/FbxProbe.cs"
    else:
        copy_bundle(Path("test-results/e11/humanoid.fbx"), assets / "Fixtures/source")
        copy_bundle(Path("test-results/e11/humanoid-published.zip"), assets / "Fixtures/exported")
        probe = Path(__file__).with_name("E12HumanoidProbe.cs")
    editors, settings, packages = assets / "Editor", project / "ProjectSettings", project / "Packages"
    for directory in (editors, settings, packages):
        directory.mkdir(parents=True, exist_ok=True)
    copy2(probe, editors)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("versions", nargs="+")
    parser.add_argument("--static", type=Path, metavar="TRIPO_DIRECTORY")
    args = parser.parse_args()
    for version in args.versions:
        prepare(version, args.static)
