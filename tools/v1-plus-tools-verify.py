"""Verify exported FBX data independently and prepare Unity comparison projects."""

from collections import Counter
import json
from math import dist, isclose
from pathlib import Path
from shutil import copy2
from subprocess import check_output
from sys import argv
from zipfile import ZipFile

from e00.fixtures import copy_bundle


root = Path("test-results/v1-plus-tools")
fixtures = Path("test-results/e03")
kinds = ("static", "skinned")
edges = ((6, 11), (11, 7), (7, 6))


def probe(*args):
    return json.loads(check_output([root / "inspect_fbx.exe", *args], text=True))


def mesh(name):
    return probe("--mesh-data", root / f"{name}.fbx")


def corner_uvs(data):
    return dict(zip((vertex for face in data["polygons"] for vertex in face), data["uv"], strict=True))


def compare(source, target, *args):
    return probe(root / f"{source}.fbx", root / f"{target}.fbx", *args)


def verify():
    report = {}
    for kind in kinds:
        raw = mesh(f"{kind}-original")
        relaxation = mesh(f"relax-{kind}-original")
        raw_uv = corner_uvs(relaxation)
        fixed = {i for i in range(25) if i % 5 in (0, 4) or i // 5 in (0, 4)} | {7}
        for suffix in ("", "-reopened"):
            target = f"relax-{kind}{suffix}"
            result = mesh(target)
            assert all(result[key] == relaxation[key] for key in ("points", "polygons", "weights"))
            relaxed = corner_uvs(result)
            assert all(relaxed[i] == raw_uv[i] for i in fixed)
            before, after = dist(raw_uv[12], (.5, .5)), dist(relaxed[12], (.5, .5))
            assert after < before / 2
            data = compare(f"relax-{kind}-original", target)
            report[target] = {"fixed": len(fixed), "centerDistanceBefore": before, "centerDistanceAfter": after,
                              "animation": data.get("animation")}
        assert mesh(f"relax-{kind}-undo") == relaxation

        for operation in ("mirror", "subdivide"):
            name = f"{operation}-{kind}"
            fixture = fixtures / f"{operation}_reference_{kind}.zip"
            reference = f"{operation}_reference_{kind}"
            with ZipFile(fixture) as zipped:
                (root / f"{reference}.fbx").write_bytes(zipped.read(f"{reference}.fbx"))
            expected = mesh(reference)
            assert mesh(f"{name}-undo") == raw
            for suffix in ("", "-reopened"):
                target = name + suffix
                result = mesh(target)
                if operation == "mirror":
                    assert all(result[key] == raw[key] for key in ("polygons", "uv", "weights"))
                    moved = [i for i, (a, b) in enumerate(zip(raw["points"], result["points"], strict=True)) if a != b]
                    assert moved == [11, 12, 13]
                    assert result["points"] == expected["points"]
                    report[target] = {"moved": moved, "animation": compare(reference, target).get("animation")}
                    continue
                assert len(result["polygons"]) == 35 and result["points"] == expected["points"]
                assert result["points"][:25] == raw["points"] and result["weights"] == expected["weights"]
                assert corner_uvs(result) == corner_uvs(expected)
                incidence = Counter(tuple(sorted((v, face[(i + 1) % len(face)]))) for face in result["polygons"] for i, v in enumerate(face))
                for midpoint, (a, b) in enumerate(edges, 25):
                    assert not incidence[tuple(sorted((a, b)))]
                    assert incidence[a, midpoint] == 2 and incidence[b, midpoint] == 2
                values = compare(reference, target, "--same-points")
                report[target] = {"points": len(result["points"]), "triangles": values["exported"]["triangles"],
                                  "sharedSplitEdges": len(edges), "animation": values.get("animation")}

    baked = probe(root / "relax-static-original.fbx", root / "relax-preserved.fbx")
    assert baked["maxPositionDeltaByControlPoint"] == 0 and baked["samePolygonConnectivity"]
    for result in report.values():
        if animation := result.get("animation"):
            assert animation["samples"] == 21 and isclose(animation["maxDeformationErrorMeters"], 0, abs_tol=1e-7)
    (root / "ufbx-v1-plus.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    for key, result in report.items():
        if not key.endswith("-reopened"):
            print(key, json.dumps(result))


def unity_project(version):
    project = root / f"unity-{version}"
    for operation in ("relax", "mirror", "subdivide"):
        for kind in kinds:
            fixture = project / "Assets/Fixtures" / f"{operation}-{kind}"
            source = f"{operation}_{'source' if operation == 'relax' else 'reference'}_{kind}.zip"
            copy_bundle(fixtures / source, fixture / "original")
            copy_bundle(root / f"{operation}-{kind}.zip", fixture / "exported")
    for folder in ("Assets/Editor", "ProjectSettings", "Packages"):
        (project / folder).mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("e00") / "FbxProbe.cs", project / "Assets/Editor/FbxProbe.cs")
    (project / "ProjectSettings/ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{m}": "1.0.0" for m in ("animation", "jsonserialize")}
    (project / "Packages/manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")


if __name__ == "__main__":
    verify()
    for version in argv[1:]:
        unity_project(version)
