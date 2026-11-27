"""Compare actual Flatten Selection exports with analytic planes and prepare the Unity fixtures."""

import json
from math import dist, sqrt
from pathlib import Path
from shutil import copy2
from subprocess import check_output
from sys import argv
from zipfile import ZipFile

from e00.fixtures import copy_bundle


output = Path("test-results/flatten-selection")
region = {6, 7, 8, 11, 12, 13, 16, 17, 18}
cases = (("custom", tuple(v / sqrt(11) for v in (1, 3, 1)), .75), ("best", (-.8, .6, 0), .5 / 9))


def inspect(*args):
    return json.loads(check_output([output / "inspect_fbx.exe", *args], text=True))


def check_plane(original, exported, selected, normal, offset):
    before = inspect("--points", output / f"{original}-original.fbx")
    after = inspect("--points", output / f"{exported}.fbx")
    assert len(before) == len(after) == 25
    plane_error, projection_error = 0., 0.
    moved = set()
    for i, (source, target) in enumerate(zip(before, after, strict=True)):
        if source != target:
            moved.add(i)
        if i in selected:
            distance = sum(x * n for x, n in zip(source, normal, strict=True)) - offset
            expected = [x - distance * n for x, n in zip(source, normal, strict=True)]
            projection_error = max(projection_error, dist(expected, target))
            plane_error = max(plane_error, abs(sum(x * n for x, n in zip(target, normal, strict=True)) - offset))
        else:
            assert source == target, f"Unselected control point {i} moved in {exported}"
    assert moved == selected and projection_error < 2e-7 and plane_error < 2e-7
    return {"selectedPoints": len(selected), "unselectedPoints": 25 - len(selected),
            "maxPlaneErrorMeters": plane_error, "maxProjectionErrorMeters": projection_error}


def check_exports():
    report = {"axis": check_plane("custom", "axis", {6, 7}, (0, 1, 0), .25)}
    for name, normal, offset in cases:
        fixture = Path("test-results/e03") / f"flatten_reference_{name}.zip"
        reference = output / f"{name}-reference.fbx"
        with ZipFile(fixture) as archive:
            reference.write_bytes(archive.read(f"flatten_reference_{name}.fbx"))
        for result in (name, f"{name}-reopened"):
            report[result] = check_plane(name, result, region, normal, offset)
            data = inspect(reference, output / f"{result}.fbx")
            assert data["samePolygonConnectivity"] and data["sameSourceSkinWeights"] and data["maxUvDeltaInCornerOrder"] == 0
            if name == "best":
                report[result]["animation"] = data["animation"]
                assert data["animation"]["samples"] == 21 and data["animation"]["maxDeformationErrorMeters"] < 2e-7
        assert inspect("--points", output / f"{name}-undo.fbx") == inspect("--points", output / f"{name}-original.fbx")
    (output / "ufbx-flatten.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def prepare_unity(version):
    project = output / f"unity-{version}"
    for name, _, _ in cases:
        fixture = project / "Assets/Fixtures" / f"flatten-{name}"
        copy_bundle(Path("test-results/e03") / f"flatten_reference_{name}.zip", fixture / "original")
        copy_bundle(output / f"{name}.zip", fixture / "exported")
    for folder in ("Assets/Editor", "ProjectSettings", "Packages"):
        (project / folder).mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("e00") / "FbxProbe.cs", project / "Assets/Editor/FbxProbe.cs")
    (project / "ProjectSettings/ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (project / "Packages/manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    check_exports()
    for version in argv[1:]:
        prepare_unity(version)
