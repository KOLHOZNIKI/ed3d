"""Compare the single indexed skinned Tripo fixture without Three.js."""

from functools import cache
from hashlib import sha256
import json
from math import cos, dist, sin
from pathlib import Path
from struct import Struct, unpack_from
import sys


class Glb:
    def __init__(self, path):
        self.bytes = path.read_bytes()
        magic, version, size, json_size, kind = unpack_from("<4sIII4s", self.bytes)
        assert (magic, version, size, kind) == (b"glTF", 2, len(self.bytes), b"JSON")
        end = 20 + json_size
        self.document = json.loads(self.bytes[20:end])
        bin_size, kind = unpack_from("<I4s", self.bytes, end)
        assert kind == b"BIN\x00" and end + 8 + bin_size == size
        self.binary = memoryview(self.bytes)[end + 8:]
        nodes = self.document["nodes"]
        self.parents = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}
        self.mesh_node, = (node for node in nodes if "mesh" in node)
        self.primitive, = self.document["meshes"][self.mesh_node["mesh"]]["primitives"]
        assert self.primitive.get("mode", 4) == 4
        self.skin = self.document["skins"][self.mesh_node["skin"]]
        self.joints = self.skin["joints"]
        self.joint_names = [nodes[index]["name"] for index in self.joints]
        self.attributes = {key: self.accessor(index) for key, index in self.primitive["attributes"].items()}
        self.indices = self.accessor(self.primitive["indices"])
        self.bind = self.accessor(self.skin["inverseBindMatrices"])

    def buffer_view(self, index):
        view = self.document["bufferViews"][index]
        assert view["buffer"] == 0
        start = view.get("byteOffset", 0)
        return self.binary[start:start + view["byteLength"]]

    def accessor(self, index):
        accessor = self.document["accessors"][index]
        assert "sparse" not in accessor and not accessor.get("normalized")
        index = accessor["bufferView"]
        data = self.buffer_view(index)
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[accessor["type"]]
        component = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}[accessor["componentType"]]
        packed = Struct("<" + component * width)
        stride = self.document["bufferViews"][index].get("byteStride", packed.size)
        start = accessor.get("byteOffset", 0)
        return [packed.unpack_from(data, start + i * stride) for i in range(accessor["count"])]

    def texture(self, role):
        doc = self.document
        material = doc["materials"][self.primitive["material"]]
        slot = material["pbrMetallicRoughness"]["baseColorTexture"] if role == "baseColor" else material["normalTexture"]
        texture = doc["textures"][slot["index"]]
        image = doc["images"][texture["source"]]
        return image["mimeType"], image["name"], self.buffer_view(image["bufferView"]), slot.get("texCoord", 0)

    def joint_parent_names(self):
        joint_name = dict(zip(self.joints, self.joint_names))
        parents = []
        for joint in self.joints:
            parent = self.parents.get(joint)
            while parent is not None and parent not in joint_name:
                parent = self.parents.get(parent)
            parents.append(joint_name.get(parent))
        return parents

    def joint_world_matrices(self, bend=False):
        nodes = self.document["nodes"]
        edited = self.joints[self.joint_names.index("Left_LowerArm")] if bend else None
        rotation = transform({"rotation": (0, 0, sin(0.55 / 2), cos(0.55 / 2))})

        @cache
        def world(index):
            local = transform(nodes[index])
            if index == edited:
                local = multiply(local, rotation)
            parent = self.parents.get(index)
            return local if parent is None else multiply(world(parent), local)

        return [world(joint) for joint in self.joints]

    def deformed(self, bend=False):
        matrices = [multiply(joint, inverse_bind) for joint, inverse_bind in zip(self.joint_world_matrices(bend), self.bind)]
        attrs = self.attributes
        points = []
        for position, joints, weights in zip(attrs["POSITION"], attrs["JOINTS_0"], attrs["WEIGHTS_0"]):
            parts = [(point(matrices[joint], position), weight) for joint, weight in zip(joints, weights) if weight]
            points.append(tuple(sum(coords[axis] * weight for coords, weight in parts) for axis in range(3)))
        return points


def multiply(a, b):
    return tuple(sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4)) for col in range(4) for row in range(4))


def point(matrix, coords):
    return tuple(sum(matrix[col * 4 + row] * coords[col] for col in range(3)) + matrix[12 + row] for row in range(3))


def transform(node):
    if "matrix" in node:
        return node["matrix"]
    x, y, z, w = node.get("rotation", (0, 0, 0, 1))
    sx, sy, sz = node.get("scale", (1, 1, 1))
    return (
        (1 - 2 * (y*y + z*z)) * sx, 2 * (x*y + z*w) * sx, 2 * (x*z - y*w) * sx, 0,
        2 * (x*y - z*w) * sy, (1 - 2 * (x*x + z*z)) * sy, 2 * (y*z + x*w) * sy, 0,
        2 * (x*z + y*w) * sz, 2 * (y*z - x*w) * sz, (1 - 2 * (x*x + y*y)) * sz, 0,
        *node.get("translation", (0, 0, 0)), 1,
    )


def compare(before, after):
    assert before.indices == after.indices, "Triangle indices or their order changed"
    assert before.attributes.keys() == after.attributes.keys()
    for key, values in before.attributes.items():
        assert values == after.attributes[key], f"{key} changed"
    assert before.primitive["extensions"]["FB_ngon_encoding"] == after.primitive["extensions"]["FB_ngon_encoding"]
    assert before.joint_names == after.joint_names and before.joint_parent_names() == after.joint_parent_names()
    assert before.skin["name"] == after.skin["name"]
    assert len(before.bind) == len(after.bind) == len(before.joints)
    affine_row = (3, 7, 11, 15)
    repaired = 0
    for original, exported in zip(before.bind, after.bind):
        assert all(original[i] == exported[i] for i in range(16) if i not in affine_row)
        assert tuple(exported[i] for i in affine_row) == (0, 0, 0, 1)
        repaired += original != exported
    bind_delta = max(abs(x - y) for a, b in zip(before.bind, after.bind) for x, y in zip(a, b))
    joint_delta = max(abs(x - y) for a, b in zip(before.joint_world_matrices(), after.joint_world_matrices()) for x, y in zip(a, b))
    assert bind_delta <= 1e-6 and joint_delta <= 1e-6
    images = {}
    for role in ("baseColor", "normal"):
        mime, name, payload, channel = before.texture(role)
        assert before.texture(role) == after.texture(role), f"{role} image bytes or binding changed"
        images[role] = {"name": name, "mimeType": mime, "bytes": len(payload), "sha256": sha256(payload).hexdigest(), "uvChannel": channel}
    rest, bent = before.deformed(), before.deformed(bend=True)
    rest_error = max(map(dist, rest, after.deformed()))
    bend_error = max(map(dist, bent, after.deformed(bend=True)))
    motion = max(map(dist, rest, bent))
    assert max(rest_error, bend_error) <= 1e-6 and motion > 0.01
    return {
        "sourceSha256": sha256(before.bytes).hexdigest(),
        "exportedSha256": sha256(after.bytes).hexdigest(),
        "vertices": len(before.attributes["POSITION"]), "triangles": len(before.indices) // 3,
        "joints": len(before.joints), "exactAttributes": sorted(before.attributes), "exactTriangleIndices": True,
        "preservedPolygonMarker": True, "textures": images, "affineRowsRepaired": repaired,
        "maxInverseBindComponentDelta": bind_delta, "maxJointWorldMatrixComponentDelta": joint_delta,
        "maxRestPositionDeltaMeters": rest_error, "maxBentPositionDeltaMeters": bend_error, "sourceBendMovementMeters": motion,
    }


if __name__ == "__main__":
    original, exported = map(Path, sys.argv[1:])
    print(json.dumps(compare(Glb(original), Glb(exported)), indent=2))
