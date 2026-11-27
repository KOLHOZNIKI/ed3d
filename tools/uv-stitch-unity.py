"""Prepare or check Unity's Generic reimport probes for UV stitch."""

from argparse import ArgumentParser
import json
from pathlib import Path
from shutil import copy2

from e00.fixtures import copy_bundle


def unity(version, verify):
    output = Path("test-results/uv-stitch")
    project = output / f"unity-{version}"
    if verify:
        report = json.loads((project / "e00-report.json").read_text(encoding="utf-8"))
        fixtures = {item["fixture"]: item for item in report["comparisons"]}
        assert set(fixtures) == {"static-uv-stitch", "animated-uv-stitch"}
        assert all(row["compatible"] for row in fixtures.values()), json.dumps(report)
        assert fixtures["animated-uv-stitch"]["clipSamples"] == 21
        print(json.dumps(report))
        return
    for name, fixture in (("static", "static-uv-stitch"), ("skinned", "animated-uv-stitch")):
        target = project / "Assets" / "Fixtures" / fixture
        copy_bundle(output / f"{name}-source.zip", target / "original")
        copy_bundle(output / f"{name}-stitched.zip", target / "exported")
    editors, settings, packages = project / "Assets/Editor", project / "ProjectSettings", project / "Packages"
    for directory in (editors, settings, packages):
        directory.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).parent / "e00/FbxProbe.cs", editors)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("versions", nargs="+")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    for version in args.versions:
        unity(version, args.verify)
