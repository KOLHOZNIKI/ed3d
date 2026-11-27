"""Validate the offline V1+ workflows with ufbx and the independent GLB reader."""

from argparse import ArgumentParser
from collections import Counter
from math import cos, dist, pi, sin
from pathlib import Path
from struct import unpack_from
from subprocess import check_output
import json

from e00.inspect_glb import Glb, multiply, point, transform


def edges(indices):
    return Counter(zip(indices, indices[1:] + indices[:1]))


def inspect_plate(read_fbx, output):
    before = read_fbx("--mesh-data", fbx(output / "plate-source"))
    after = read_fbx("--mesh-data", fbx(output / "plate-reopened"))
    original = before["points"]
    edited = after["points"]
    assert edited[:-3] == original
    ring = before["polygons"][1]
    cap = list(range(len(original), len(edited)))
    assert len(cap) == 3
    walls = []
    for i, start in enumerate(ring):
        end = (i + 1) % 3
        walls.extend(([start, ring[end], cap[end]], [start, cap[end], cap[i]]))
    expected = before["polygons"][:1] + [cap] + before["polygons"][2:] + walls
    step = 0
    for polygon in expected:
        triangles = after["polygons"][step:step + len(polygon) - 2]
        assert all(len(triangle) == 3 and set(triangle) <= set(polygon) for triangle in triangles)
        sides = sum(map(edges, triangles), Counter())
        assert sides - Counter({(end, start): count for (start, end), count in sides.items()}) == edges(polygon)
        step += len(triangles)
    assert step == len(after["polygons"])
    displacements = [tuple(b - a for a, b in zip(original[start], edited[end])) for start, end in zip(ring, cap)]
    assert all(dist(delta, displacements[0]) < 1e-9 and abs(dist(delta, (0, 0, 0)) - .0002) < 1e-9 for delta in displacements)
    assert len(after["uv"]) == 3 * step and after["uv"] != before["uv"]
    assert all(0 <= value <= 1 for uv in after["uv"] for value in uv)
    png, = (output / "plate-reopened").rglob("BaseColor.png")
    initial_png, = (output / "plate").rglob("BaseColor.png")
    assert png.read_bytes() == initial_png.read_bytes()
    dimensions = unpack_from(">II", png.read_bytes(), 16)
    assert dimensions == (1024, 1024)
    replay = read_fbx(fbx(output / "plate"), fbx(output / "plate-reopened"))
    assert replay["exported"]["textures"] == 1 and replay["maxUvDeltaInCornerOrder"] == 0
    assert replay["samePolygonConnectivity"] and replay["maxPositionDeltaByControlPoint"] == 0
    return {"controlPointsAdded": len(cap), "trianglesAdded": len(walls), "depthMeters": dist(displacements[0], (0, 0, 0)),
            "pngDimensions": dimensions, "replay": replay}


def inspect_tripo(path, exported):
    before, after = Glb(path), Glb(exported)
    assert before.indices == after.indices and before.attributes.keys() == after.attributes.keys()
    exact_attributes = ("TEXCOORD_0", "JOINTS_0", "WEIGHTS_0")
    assert all(before.attributes[name] == after.attributes[name] for name in exact_attributes)
    assert before.primitive["extensions"]["FB_ngon_encoding"] == after.primitive["extensions"]["FB_ngon_encoding"]
    assert before.joint_names == after.joint_names and before.joint_parent_names() == after.joint_parent_names()
    assert all(before.texture(role) == after.texture(role) for role in ("baseColor", "normal"))
    joint = before.joints[before.joint_names.index("Left_UpperArm")]
    node = before.document["nodes"][joint]
    rotation = transform({"rotation": [0, 0, sin(pi / 24), cos(pi / 24)]})
    original = before.deformed()
    node["matrix"] = multiply(transform(node), rotation)
    expected = before.deformed()
    actual = after.deformed()
    error = max(map(dist, expected, actual))
    motion = max(map(dist, original, actual))
    nodes = after.document["nodes"]
    index = next(i for i, node in enumerate(nodes) if node is after.mesh_node)
    mesh_world = transform(after.mesh_node)
    while index in after.parents:
        index = after.parents[index]
        mesh_world = multiply(transform(nodes[index]), mesh_world)
    bind_error = max(dist(deformed, point(mesh_world, base)) for deformed, base in zip(actual, after.attributes["POSITION"], strict=True))
    assert error <= 1e-6 and motion > .08 and bind_error <= 1e-6
    return {"joints": len(after.joints), "triangles": len(after.indices) // 3, "exactAttributes": exact_attributes,
            "exactTextures": True, "maxExpectedPoseErrorMeters": error, "maxRestBindErrorMeters": bind_error, "motionMeters": motion}


def fbx(folder):
    path, = folder.glob("*.fbx")
    return path


def main(options):
    output = options.output

    def read_fbx(*args):
        return json.loads(check_output([options.ufbx.resolve(), *map(str, args)]))

    shared = read_fbx(output / "shared-reference.fbx", fbx(output / "shared-reopened"), "--base-pose")
    edited = fbx(output / "character-reopened")
    character = read_fbx(options.character, edited, 100, .03125)
    assert character["positionEdit"]["matches"] and character["maxUvDeltaInCornerOrder"] == 0
    replay = read_fbx(fbx(output / "character"), edited, "--clip-extrema")
    assert replay["animation"]["maxDeformationErrorMeters"] == 0 and replay["animation"]["maxExtremaErrorMeters"] == 0
    report = {"sharedSkin": shared, "plate": inspect_plate(read_fbx, output), "animatedCharacter": character,
              "animatedReplay": replay, "tripo": inspect_tripo(options.tripo, output / "tripo-reopened.glb")}
    (output / "independent.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("Verified the shared rig, the plate extrusion and UV replay, and both character workflows.")


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("test-results/base-pose"))
    parser.add_argument("--ufbx", type=Path, default=Path("test-results/base-pose/inspect_fbx.exe"))
    parser.add_argument("--tripo", type=Path, default=Path("D:/downloads/Tripo/man character 3d model.glb"))
    parser.add_argument("--character", type=Path, default=Path("test-results/e00/ufbx/data/maya_kenney_character_7700_binary.fbx"))
    main(parser.parse_args())
