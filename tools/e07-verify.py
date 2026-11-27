"""Check independent textures and GLB contents and prepare the Unity FBX cases."""

from argparse import ArgumentParser
from io import BytesIO
import json
from math import dist
from pathlib import Path
from shutil import copy2
from zipfile import ZipFile

from PIL import Image
from e00.fixtures import copy_bundle
from e00.inspect_glb import GlbDocument, multiply, point, transform

results = Path("test-results/e07")


def asset(path):
    glb = GlbDocument(path)
    doc = glb.document
    parents = {child: i for i, node in enumerate(doc["nodes"]) for child in node.get("children", [])}

    def world(i):
        local = transform(doc["nodes"][i])
        return local if i not in parents else multiply(world(parents[i]), local)

    meshes = {}
    for i, node in enumerate(doc["nodes"]):
        if "mesh" not in node:
            continue
        primitive, = doc["meshes"][node["mesh"]]["primitives"]
        indices = glb.accessor(primitive["indices"])
        positions = glb.accessor(primitive["attributes"]["POSITION"])
        material = doc["materials"][primitive["material"]]
        color = material["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        info = doc["images"][doc["textures"][color]["source"]]
        meshes[node["name"]] = ([point(world(i), positions[j]) for j, in indices], bytes(glb.buffer_view(info["bufferView"])))
    return meshes, doc


def verify():
    corpus = Path("tools/e00/fixtures/corpus/f07_shared_atlas.glb")
    original, _ = asset(corpus)
    exported, doc = asset(results / "handle.glb")
    combined, _ = asset(results / "whole.glb")
    assert len(exported) == len(doc["images"]) == len(doc["materials"]) == 1
    before, original_png = original["Handle"]
    positions, png = exported["Isolated_Handle"]
    assert len(before) == len(positions) == 12
    error = max(map(dist, before, positions))
    assert error < 1e-6 and original_png != png
    assert all(combined[key] == value for key, value in original.items())
    shared, shared_doc = asset(results / "whole-with-shared-copy.glb")
    copy, = [key for key in shared if key.startswith("Lid_part_")]
    assert len(shared_doc["images"]) == 3 and shared[copy][1] == original["Lid"][1]

    with ZipFile(results / "assembly.zip") as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["meshes"]["triangles"] == 6 and len(manifest["textures"]) == 1
        rgba = Image.open(BytesIO(archive.read(manifest["textures"][0]["file"]))).convert("RGBA")
        colors = rgba.getcolors(65536)
        assert set(color for _, color in colors) == {
            (30, 55, 200, 255), (40, 58, 195, 255), (50, 61, 190, 255)
        }
    report = {"glbWorldCornerError": error, "glbOriginalMeshesAndTextureBytesUnchanged": True,
              "fbxAtlasColors": len(colors), "fbxUnrelatedAtlasColors": 0}
    (results / "independent-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def prepare(version):
    project = results / f"unity-{version}"
    for name in ("batch", "assembly", "rebased"):
        copy_bundle(results / f"{name}.zip", project / "Assets/Fixtures" / name)
    script = project / "Assets/Editor/E07Probe.cs"
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
    args = parser.parse_args()
    verify()
    if args.unity:
        prepare(args.unity)
