"""Verify the edge and face Extrude exports and prepare Unity comparison projects."""

from collections import Counter
import json
from math import isfinite
from pathlib import Path
from shutil import copy2
from subprocess import check_output
from sys import argv
from zipfile import ZipFile

from e00.fixtures import copy_bundle


root = Path("test-results/extrude")
fixtures = Path("test-results/e03")
cases = {"edge": (2, 36, [0, 1, 2]), "region": (4, 40, [6, 7, 11, 12])}


def probe(*args):
    return json.loads(check_output([root / "inspect_fbx.exe", *args], text=True))


def mesh(path):
    return probe("--mesh-data", path)


def incidence(data):
    return Counter(tuple(sorted((v, face[(i + 1) % len(face)])))
                   for face in data["polygons"] for i, v in enumerate(face))


def verify():
    source = mesh(root / "source.fbx")
    report = {}
    for mode, (walls, triangles, source_ids) in cases.items():
        reference = root / f"{mode}-reference.fbx"
        with ZipFile(fixtures / f"extrude_reference_{mode}.zip") as archive:
            reference.write_bytes(archive.read(f"extrude_reference_{mode}.fbx"))
        shape = mesh(reference)
        assert mesh(root / f"{mode}-undo.fbx") == source
        for suffix in ("", "-reopened"):
            path = root / f"{mode}{suffix}.fbx"
            result = mesh(path)
            assert result["points"] == shape["points"] and result["points"][:25] == source["points"]
            assert result["uv"][:96] == source["uv"] and len(result["uv"]) == 96 + 4 * walls
            assert len(result["polygons"]) == 32 + walls
            perimeter = incidence(result)
            assert max(perimeter.values()) == 2
            boundary = list(zip(source_ids, source_ids[1:])) if mode == "edge" else [(6, 11), (11, 12), (12, 7), (7, 6)]
            copies = {id: i for i, id in enumerate(source_ids, 25)}
            for a, b in boundary:
                assert perimeter[tuple(sorted((a, b)))] == 2
                assert perimeter[tuple(sorted((copies[a], copies[b])))] == (1 if mode == "edge" else 2)
            expected_faces = source["polygons"].copy()
            if mode == "region":
                for index in (10, 11):
                    expected_faces[index] = [copies[id] for id in expected_faces[index]]
            assert result["polygons"][:32] == expected_faces
            side_uvs = result["uv"][96:]
            assert all(isfinite(v) and 0 < v < 1 for uv in side_uvs for v in uv)
            assert any(all(uv[axis] < .125 for uv in side_uvs) or all(uv[axis] > .625 for uv in side_uvs) for axis in (0, 1))
            for i in range(0, len(side_uvs), 4):
                a, b, c, d = side_uvs[i:i + 4]
                assert b[0] > a[0] and d[1] > a[1] and c == [b[0], d[1]]
            data = probe(reference, path, "--same-points")
            assert data["exported"]["triangles"] == triangles and data["maxPointError"] == 0
        report[mode] = {"wallQuads": walls, "triangles": triangles, "originalPointsUnchanged": 25,
                        "joinedEdges": len(boundary), "unchangedSourceUvCorners": 96, "offlineReopen": True}
    (root / "ufbx-extrude.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def unity_project(version):
    project = root / f"unity-{version}"
    for mode in cases:
        fixture = project / "Assets/Fixtures" / mode
        copy_bundle(fixtures / f"extrude_reference_{mode}.zip", fixture / "original")
        copy_bundle(root / f"{mode}.zip", fixture / "exported")
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
