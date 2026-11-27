"""Check GLB repair and projection outputs independently and assemble Unity inputs."""

from argparse import ArgumentParser
from collections import Counter
from io import BytesIO
import json
from math import acos, degrees, hypot, sqrt
from pathlib import Path
from shutil import copy2
from zipfile import ZipFile

from PIL import Image
from e00.fixtures import copy_bundle
from e00.inspect_glb import GlbDocument

results = Path("test-results/e08")
corpus = Path("tools/e00/fixtures/corpus")


def primitive(path, name):
    glb = GlbDocument(path)
    node, = [node for node in glb.document["nodes"] if "mesh" in node and node.get("name", "").replace("_", " ") == name]
    shape, = glb.document["meshes"][node["mesh"]]["primitives"]
    attributes = {key: glb.accessor(index) for key, index in shape["attributes"].items()}
    indices = [i for i, in glb.accessor(shape["indices"])]
    return glb, shape, attributes, indices


def edges(positions, indices):
    triangles = [[positions[j] for j in indices[i:i + 3]] for i in range(0, len(indices), 3)]
    return Counter(tuple(sorted((a, b))) for triangle in triangles for a, b in zip(triangle, triangle[1:] + triangle[:1]))


def verify_repairs():
    groups = {}
    for mesh, source, after in (
        ("NonPlanar", "f03_boundaries.glb", "f03-smooth.glb"),
        ("GridRing", "f05_grid_bridge.glb", "f05-grid-bridge.glb"),
        ("BridgeEnds", "f05_grid_bridge.glb", "f05-grid-bridge.glb"),
        ("BridgeEnds", "f05_grid_bridge.glb", "f05-twisted.glb"),
    ):
        _, _, original, before_indices = primitive(corpus / source, mesh)
        _, _, repaired, after_indices = primitive(results / after, mesh)
        a, b = original["POSITION"], repaired["POSITION"]
        for attr in ("POSITION", "NORMAL"):
            assert [original[attr][i] for i in before_indices] == [repaired[attr][i] for i in after_indices[:len(before_indices)]]
        assert any(n == 1 for n in edges(a, before_indices).values())
        assert set(edges(b, after_indices).values()) == {2}
        new = set(b) - set(a)
        groups[after + "/" + mesh] = {"addedTriangles": (len(after_indices) - len(before_indices)) // 3, "newPoints": len(new)}
        if mesh == "BridgeEnds":
            assert len(new) == 16
            radius = min(hypot(x, z) for x, _, z in new)
            if after == "f05-grid-bridge.glb":
                assert abs(radius - .6) < 1e-6
            else:
                assert .5 < radius < .59
            groups[after + "/" + mesh]["minimumNewRadius"] = radius
    _, _, spans, span_indices = primitive(results / "f05-bridge-spans.glb", "BridgeEnds")
    incidence = edges(spans["POSITION"], span_indices)
    assert set(incidence.values()) == {1, 2} and sum(n == 1 for n in incidence.values()) == 16
    assert len(span_indices) // 3 == 62
    groups["f05-bridge-spans.glb/BridgeEnds"] = {"addedTriangles": 18, "remainingBoundaryEdges": 16}
    return groups


def image(glb, slot):
    texture = glb.document["textures"][slot["index"]]
    encoded = glb.document["images"][texture["source"]]
    return Image.open(BytesIO(glb.buffer_view(encoded["bufferView"]))).convert("RGBA")


def normalize(vector):
    length = sqrt(sum(v * v for v in vector))
    return [v / length for v in vector]


def cross(a, b):
    return [a[i - 2] * b[i - 1] - a[i - 1] * b[i - 2] for i in range(3)]


def verify_projection():
    result = {}
    for name in ("red", "miss", "filled", "nearest"):
        glb, shape, attributes, indices = primitive(results / f"projection-{name}.glb", "Changed target")
        material = glb.document["materials"][shape["material"]]
        color = image(glb, material["pbrMetallicRoughness"]["baseColorTexture"])
        normals = image(glb, material["normalTexture"])
        assert material["alphaMode"] == "BLEND"
        assert material.get("doubleSided", False) is False
        samples = [color.getpixel((x, y)) for x in range(32, 224, 8) for y in range(32, 224, 8)]
        if name in ("miss", "filled"):
            assert set(samples) == ({(0, 0, 0, 0)} if name == "miss" else {(238, 17, 136, 255)})
            continue
        assert set(samples) == {(230, 24, 35, 255)}
        # The source tangent runs along +X. glTF's top-down UV convention
        # reverses the Y contribution for the source's positive UV winding.
        raw = [v / 127.5 - 1 for v in (181, 170, 235)]
        expected = normalize([raw[0] / 2, -raw[1], raw[2]])
        p, q, r = [attributes["POSITION"][i] for i in indices[:3]]
        first, second, third = [attributes["TEXCOORD_0"][i] for i in indices[:3]]
        e, f = [q[i] - p[i] for i in range(3)], [r[i] - p[i] for i in range(3)]
        du, dv = second[0] - first[0], second[1] - first[1]
        eu, ev = third[0] - first[0], third[1] - first[1]
        det = du * ev - dv * eu
        t = normalize([(e[i] * ev - f[i] * dv) / det for i in range(3)])
        n = normalize(cross(e, f))
        b = [value * (-1 if det > 0 else 1) for value in cross(n, t)]
        maximum = 0
        for x in range(40, 216, 8):
            for y in range(40, 216, 8):
                decoded = [v / 127.5 - 1 for v in normals.getpixel((x, y))[:3]]
                actual = normalize([t[i] * decoded[0] + b[i] * decoded[1] + n[i] * decoded[2] for i in range(3)])
                maximum = max(maximum, degrees(acos(max(-1, min(1, sum(x * y for x, y in zip(expected, actual)))))))
        assert maximum < 2, maximum
        result[name] = {"maxNormalDegrees": maximum, "unrelatedColorSamples": 0, "sampledTexels": len(samples)}
    with ZipFile(results / "projection.assetfixer") as project:
        manifest = json.loads(project.read("manifest.json"))
        transfer, = manifest["working"]["uvBakes"].values()
        bake = transfer["bake"]
        mask = Image.open(BytesIO(project.read(f"blobs/{bake['coverage']}"))).convert("RGBA")
        assert bake["projection"]["eligibleSources"] == [[0]] and bake["projection"]["misses"] == 0
        result["coveredTexels"] = bake["covered"]
        assert sum(count for count, color in mask.getcolors() if color == (48, 189, 161, 255)) == bake["covered"]
    with ZipFile(results / "projection-nearest.assetfixer") as project:
        transfer, = json.loads(project.read("manifest.json"))["working"]["uvBakes"].values()
        bake = transfer["bake"]
        mask = Image.open(BytesIO(project.read(f"blobs/{bake['coverage']}"))).convert("RGBA")
        assert bake["projection"]["nearest"] == bake["covered"] == result["coveredTexels"]
        assert sum(count for count, color in mask.getcolors() if color == (248, 174, 50, 255)) == bake["covered"]
    return result


def prepare(version, tripo):
    project = results / f"unity-{version}"
    for name in ("patch", "patch-grid", "patch-smooth", "patch-projected"):
        copy_bundle(results / f"{name}.zip", project / "Assets/Fixtures" / name)
    if (results / "skinned-smooth.zip").exists():
        copy_bundle(Path("test-results/e05/skinned-bottle.zip"), project / "Assets/Fixtures/skin")
        copy_bundle(results / "skinned-smooth.zip", project / "Assets/Fixtures/skin-smooth")
    if tripo and (results / "tripo-smooth.zip").exists():
        copy_bundle(tripo / "ceramic plate 3d model.zip", project / "Assets/Fixtures/tripo")
        for name in ("tripo-grid", "tripo-smooth"):
            copy_bundle(results / f"{name}.zip", project / "Assets/Fixtures" / name)
    script = project / "Assets/Editor/E08Probe.cs"
    script.parent.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name(script.name), script)
    for filename, content in {
        "ProjectSettings/ProjectVersion.txt": f"m_EditorVersion: {version}\n",
        "Packages/manifest.json": json.dumps({"dependencies": {
            f"com.unity.modules.{module}": "1.0.0" for module in ("animation", "imageconversion", "jsonserialize")
        }}),
    }.items():
        path = project / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--unity")
    parser.add_argument("--tripo", type=Path)
    args = parser.parse_args()
    result = {"repairs": verify_repairs(), "projection": verify_projection()}
    (results / "independent-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    if args.unity:
        prepare(args.unity, args.tripo)
