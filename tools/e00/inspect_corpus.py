"""Check the E00 fixture semantics and exports independently of Three.js."""

from collections import Counter, defaultdict
from hashlib import sha256
import json
from math import cos, dist, pi, sin
from pathlib import Path
import sys

from inspect_glb import Glb, GlbDocument, multiply, point, transform


def near(a, b, tolerance=1e-6):
    assert len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b)), (a, b)


def meshes(asset):
    document = asset.document
    return {
        node["name"]: (node, document["meshes"][node["mesh"]]["primitives"][0])
        for node in document["nodes"] if "mesh" in node
    }


def mesh_data(asset, primitive):
    indices = tuple(i for (i,) in asset.accessor(primitive["indices"]))
    attributes = {key: asset.accessor(value) for key, value in primitive["attributes"].items()}
    return indices, attributes


def components(vertices, edges):
    adjacent = defaultdict(set)
    for a, b in edges:
        adjacent[a].add(b)
        adjacent[b].add(a)
    found, pending = [], set(vertices)
    while pending:
        frontier = [pending.pop()]
        component = set(frontier)
        while frontier:
            next_vertices = adjacent[frontier.pop()] & pending
            pending.difference_update(next_vertices)
            component.update(next_vertices)
            frontier.extend(next_vertices)
        found.append(component)
    return found


def topology(indices, vertex_count):
    assert len(indices) % 3 == 0 and min(indices) >= 0 and max(indices) < vertex_count
    edges = Counter()
    for a, b, c in zip(indices[::3], indices[1::3], indices[2::3]):
        assert len({a, b, c}) == 3
        edges.update(tuple(sorted(edge)) for edge in ((a, b), (b, c), (c, a)))
    boundary = [edge for edge, degree in edges.items() if degree == 1]
    endpoints = Counter(vertex for pair in boundary for vertex in pair)
    return (components(range(vertex_count), edges), components(endpoints, boundary),
            [edge for edge, degree in edges.items() if degree > 2], endpoints)


def texture(asset, primitive):
    doc = asset.document
    material = doc["materials"][primitive["material"]]
    slot = material["pbrMetallicRoughness"]["baseColorTexture"]
    uv = slot.get("texCoord", 0)
    uv_transform = slot.get("extensions", {}).get("KHR_texture_transform", {})
    uv = uv_transform.get("texCoord", uv)
    image = doc["images"][doc["textures"][slot["index"]]["source"]]
    return (sha256(asset.buffer_view(image["bufferView"])).hexdigest(), uv, material.get("alphaMode", "OPAQUE"),
            material.get("alphaCutoff", .5), tuple(uv_transform.get("offset", (0, 0))), uv_transform.get("rotation", 0),
            tuple(uv_transform.get("scale", (1, 1))))


def check_meshes(before, after):
    a, b = meshes(before), meshes(after)
    assert a.keys() == b.keys(), (a.keys(), b.keys())
    for name, (node, primitive) in a.items():
        new_node, new_primitive = b[name]
        near(transform(node), transform(new_node))
        indices, attrs = mesh_data(before, primitive)
        new_indices, new_attrs = mesh_data(after, new_primitive)
        assert indices == new_indices and attrs.keys() == new_attrs.keys(), name
        for key, values in attrs.items():
            if key == "NORMAL":
                for original, exported in zip(values, new_attrs[key]):
                    near(original, exported)
            else:
                assert values == new_attrs[key], (name, key)
    return {name: mesh_data(before, primitive) for name, (_, primitive) in a.items()}


def channel(asset, path):
    clip, = asset.document["animations"]
    track, = clip["channels"]
    sampler = clip["samplers"][track["sampler"]]
    assert track["target"]["path"] == path and sampler.get("interpolation", "LINEAR") == "LINEAR"
    assert asset.accessor(sampler["input"]) == [(0,), (.5,), (1,)]
    return clip["name"], track["target"]["node"], asset.accessor(sampler["output"])


def wide_torso(asset):
    assert asset.joint_names == ["Pelvis", "Spine", "Chest", "Head", "LeftArm", "RightArm", "LeftLeg", "RightLeg"]
    assert asset.joint_parent_names() == [None, "Pelvis", "Spine", "Chest", "Chest", "Chest", "Pelvis", "Pelvis"]
    assert asset.skin["skeleton"] == asset.joints[0]
    position = asset.attributes["POSITION"][24]
    near(position, (.70, 1.05, 0))
    indices = asset.attributes["JOINTS_0"][24]
    weights = asset.attributes["WEIGHTS_0"][24]
    assert indices == (1,0,2,0) and weights == (.5,.25,.25,0)
    assert all(abs(sum(row) - 1) <= 1e-5 for row in asset.attributes["WEIGHTS_0"])
    name, target, values = channel(asset, "rotation")
    assert name == "TorsoSweep" and target == asset.joints[1]
    near(values[1], (0, 0, sin(pi / 12), cos(pi / 12)))
    nodes = asset.document["nodes"]
    rest = asset.joint_world_matrices()
    near(point(rest[2], (0,0,0)), (0,1.46,0))
    for world, inverse in zip(rest, asset.bind):
        near(multiply(world, inverse), transform({}))

    def world(index):
        node = nodes[index]
        local = transform({**node, "rotation": values[1]}) if index == target else transform(node)
        parent = asset.parents.get(index)
        return local if parent is None else multiply(world(parent), local)

    posed = [point(multiply(world(asset.joints[joint]), asset.bind[joint]), position) for joint in indices]
    result = tuple(sum(weight * p[axis] for weight, p in zip(weights, posed)) for axis in range(3))
    angle = pi / 6
    near(result, (.25 * .70 + .75 * (.70*cos(angle) + .03*sin(angle)),
                  .25 * 1.05 + .75 * (1.08 + .70*sin(angle) - .03*cos(angle)), 0))
    assert dist(position, result) > .25
    return result


def transformed_clip(asset):
    nodes = asset.document["nodes"]
    name, target, values = channel(asset, "translation")
    assert name == "ReferenceLift" and nodes[target]["name"] == "MovingPanel"
    parents = {child: node for node in nodes for child in node.get("children", [])}
    middle = parents[target]
    root = parents[nodes.index(middle)]
    assert (root["name"], middle["name"]) == ("SurveyRoot", "Intermediate")
    near(root["scale"], (.01,.01,.01))
    matrices = [multiply(multiply(transform(root), transform(middle)), transform({"translation": value})) for value in values]
    result = [point(matrix, (0,0,0)) for matrix in matrices]
    for value, expected in zip(result, [(2,3,3.75), (2,3.5,3.75), (2,3,3.75)]):
        near(value, expected)
    return result


def main(source, output):
    cases = ["f03_boundaries", "f04_bottle", "f05_grid_bridge", "f07_shared_atlas", "f08_material_bindings",
             "f11_wide_torso", "f12_coordinate_root", "f16_non_manifold"]
    before = {key: GlbDocument(source / f"{key}.glb") for key in cases}
    after = {key: GlbDocument(output / f"{key}_e00.glb") for key in cases}
    observed = {key: check_meshes(before[key], after[key]) for key in cases}
    topologies = {
        key: {name: topology(indices, len(attrs["POSITION"])) for name, (indices, attrs) in data.items()}
        for key, data in observed.items()
    }
    planar, non_planar = (observed["f03_boundaries"][key][1]["POSITION"][8:16] for key in ("ConcavePlanar", "NonPlanar"))
    turns = [((b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0])) for a,b,c in zip(planar, planar[1:]+planar[:1], planar[2:]+planar[:2])]
    assert all(z == 0 for _, _, z in planar) and min(turns) < 0 < max(turns)
    assert non_planar[0][2] == non_planar[2][2] == non_planar[4][2] == 0 and non_planar[1][2] > .25
    for _, loops, nonmanifold, endpoints in topologies["f03_boundaries"].values():
        assert loops == [set(range(8,16))] and not nonmanifold and all(degree == 2 for degree in endpoints.values())
    _, loops, nonmanifold, endpoints = topologies["f04_bottle"]["Bottle"]
    mouth = set(range(48,60))
    assert sorted(map(len, loops)) == [3,3,12] and mouth in loops and not nonmanifold and set(endpoints.values()) == {2}
    for asset in (before["f04_bottle"], after["f04_bottle"]):
        assert set(meshes(asset)["Bottle"][0]["extras"]["protectedLoop"]) == mouth
    _, loops, nonmanifold, _ = topologies["f05_grid_bridge"]["GridRing"]
    assert loops == [set(range(4,8))] and not nonmanifold
    parts, loops, nonmanifold, endpoints = topologies["f05_grid_bridge"]["BridgeEnds"]
    assert len(parts) == 2 and sorted(map(len, loops)) == [8,8] and not nonmanifold and set(endpoints.values()) == {2}
    assert {name: len(shape[0]) for name, shape in topologies["f07_shared_atlas"].items()} == {"Tray":1, "Handle":2, "Lid":1}
    atlas_ranges = []
    for name, (indices, attrs) in observed["f07_shared_atlas"].items():
        for vertices in topologies["f07_shared_atlas"][name][0]:
            us = [attrs["TEXCOORD_0"][vertex][0] for vertex in vertices]
            atlas_ranges.append((min(us), max(us)))
    ranges = sorted(atlas_ranges)
    assert len(ranges) == 4 and all(a[1] < b[0] for a,b in zip(ranges, ranges[1:]))
    textures = {}
    for key in ("f07_shared_atlas", "f08_material_bindings"):
        textures[key] = {}
        for name, (_, primitive) in meshes(before[key]).items():
            original = texture(before[key], primitive)
            exported = texture(after[key], meshes(after[key])[name][1])
            assert original[:4] == exported[:4]
            near((*original[4], original[5], *original[6]), (*exported[4], exported[5], *exported[6]))
            textures[key][name] = original
    assert len({value[0] for value in textures["f07_shared_atlas"].values()}) == 1
    cutout = textures["f08_material_bindings"]["CutoutPanel"]
    veil = textures["f08_material_bindings"]["VeilPanel"]
    assert cutout[1:] == (0, "MASK", .375, (.25, 0), -.2, (1,.5))
    assert veil[0] != cutout[0] and veil[1:] == (1, "BLEND", .5, (.125,.25), .4, (.75,1.25))

    skin_before = Glb(source / "f11_wide_torso.glb")
    skin_after = Glb(output / "f11_wide_torso_e00.glb")
    assert skin_before.bind == skin_after.bind and skin_before.skin["name"] == skin_after.skin["name"]
    posed = wide_torso(skin_before)
    near(posed, wide_torso(skin_after))
    motion = transformed_clip(before["f12_coordinate_root"])
    for a, b in zip(motion, transformed_clip(after["f12_coordinate_root"])):
        near(a, b)
    invalid = GlbDocument(source / "f16_invalid_index.glb")
    indices, attrs = mesh_data(invalid, meshes(invalid)["OutOfRange"][1])
    assert len(attrs["POSITION"]) == 4 and [i for i in indices if i >= 4] == [19]
    assert topologies["f16_non_manifold"]["ThreeAlongOneEdge"][2] == [(0,1)]
    report = {
        "topology": {key: {name: {"components": len(shape[0]), "boundarySizes": sorted(map(len, shape[1])),
                                  "nonManifoldEdges": shape[2]} for name, shape in data.items()} for key, data in topologies.items()},
        "sourceHashes": {path.name: sha256(path.read_bytes()).hexdigest() for path in sorted(source.iterdir()) if path.is_file()},
        "textures": textures, "wideTorsoMidPose": posed, "coordinateClipWorldCenters": motion,
    }
    (output / "independent-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(*(Path(arg) for arg in sys.argv[1:]))
