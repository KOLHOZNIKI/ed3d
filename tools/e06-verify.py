"""Check E06 GLB exports independently and prepare FBX fixtures for Unity and ufbx."""

import argparse
import io
import json
from pathlib import Path
import sys
from shutil import copy2

from PIL import Image

tools = Path(__file__).resolve().parent
sys.path.insert(0, str(tools / "e00"))
from fixtures import copy_bundle, copy_corner_map
from inspect_glb import GlbDocument


def squares(path):
    glb = GlbDocument(path)
    doc = glb.document
    primitive, = doc["meshes"][0]["primitives"]
    attrs = {name: glb.accessor(index) for name, index in primitive["attributes"].items()}
    corners = [index for index, in glb.accessor(primitive["indices"])]
    material = doc["materials"][primitive["material"]]
    assert material["alphaMode"] == "BLEND"
    color = material["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    image = doc["images"][doc["textures"][color]["source"]]
    png = bytes(glb.buffer_view(image["bufferView"]))
    return attrs, corners, png


def nearest(image, u, v):
    return image.getpixel((min(image.width - 1, max(0, int(u * image.width))),
                           min(image.height - 1, max(0, int(v * image.height)))))


def sample(image, triangle, weights):
    return nearest(image, *(sum(vertex[i] * w for vertex, w in zip(triangle, weights)) for i in range(2)))


def verify_glb(results):
    original, original_indices, original_png = squares(results / "squares.glb")
    moved, moved_indices, moved_png = squares(results / "squares-moved.glb")
    packed, packed_indices, packed_png = squares(results / "squares-packed.glb")
    changed = []
    for name in ("POSITION", "NORMAL"):
        before = [original[name][index] for index in original_indices]
        assert all(before == [attrs[name][index] for index in indices]
                   for attrs, indices in ((moved, moved_indices), (packed, packed_indices)))
    for i, (before, after) in enumerate(zip(original_indices, moved_indices)):
        uv = original["TEXCOORD_0"][before]
        actual = moved["TEXCOORD_0"][after]
        if uv != actual:
            assert uv == (0, 0) and actual == (0.125, 0.0625)
            changed.append(i)
    assert changed == [0, 3] and original_png == moved_png
    before = Image.open(io.BytesIO(moved_png)).convert("RGBA")
    after = Image.open(io.BytesIO(packed_png)).convert("RGBA")
    worst = [0] * 4
    samples = 0
    for i in range(0, len(moved_indices), 3):
        source_uv = [moved["TEXCOORD_0"][j] for j in moved_indices[i:i + 3]]
        target_uv = [packed["TEXCOORD_0"][j] for j in packed_indices[i:i + 3]]
        for a in range(1, 12):
            for b in range(1, 12 - a):
                weights = (a / 12, b / 12, (12 - a - b) / 12)
                source_u = sum(uv[0] * w for uv, w in zip(source_uv, weights))
                if abs(source_u - 0.5) < 0.03:
                    continue
                p, q = sample(before, source_uv, weights), sample(after, target_uv, weights)
                worst = [max(previous, abs(x - y)) for previous, x, y in zip(worst, p, q)]
                samples += 1
    assert max(worst[:3]) <= 9 and worst[3] == 0, worst
    report = {"movedCornerOccurrences": changed, "mappingPreservedImageBytes": True,
              "unchangedPositionsAndNormals": True, "appearanceSamples": samples, "maximumRgbaError": worst}
    (results / "glb-independent.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def prepare_unity(results, version, tripo):
    project = results / f"unity-{version}"
    fixtures = project / "Assets" / "Fixtures"
    plate_source = tripo / "ceramic plate 3d model.zip"
    fixtures = fixtures.resolve()
    cases = {
        "static": (results / "plate-painted.zip", results / "plate-rebaked.zip", results / "plate-painted.zip"),
        "skinned": (tripo / "tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip", results / "skin-rebaked.zip", None),
        "directional": (results.parent / "e00" / "normal-fixture" / "directional_normals.zip", results / "normal-rebaked.zip", None),
    }
    for name, (source, baked, reference) in cases.items():
        location = fixtures / name
        copy_bundle(source, location / "original")
        copy_bundle(baked, location / "exported")
        copy_corner_map(baked, location)
        if reference:
            copy_bundle(reference, location / "reference")
    raw_plate = results / "ufbx-plate-source"
    copy_bundle(plate_source, raw_plate)
    editor = project / "Assets" / "Editor"
    editor.mkdir(parents=True, exist_ok=True)
    for name in ("FbxProbe.cs", "NormalBakeProbe.cs", "NormalBakeProbe.shader", "TextureBakeProbe.cs", "TextureBakeProbe.shader"):
        copy2(tools / "e00" / name, editor)
    copy2(tools / "e06-unity.cs", editor / "E06Probe.cs")
    for directory, filename, content in (
        ("ProjectSettings", "ProjectVersion.txt", f"m_EditorVersion: {version}\n"),
        ("Packages", "manifest.json", json.dumps({"dependencies": {
            f"com.unity.modules.{module}": "1.0.0" for module in ("animation", "imageconversion", "jsonserialize")}})),
    ):
        (project / directory).mkdir(exist_ok=True)
        (project / directory / filename).write_text(content, encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unity")
    parser.add_argument("--tripo", type=Path, default=Path("D:/downloads/Tripo"))
    args = parser.parse_args()
    results = Path("test-results/e06")
    verify_glb(results)
    if args.unity:
        prepare_unity(results, args.unity, args.tripo)
