"""Independently compare the edited Tripo GLB with its original."""

from hashlib import sha256
from pathlib import Path
from math import dist
from struct import pack, unpack
from sys import argv
import json

from e00.inspect_glb import Glb, GlbDocument


def single(value):
    return unpack("<f", pack("<f", value))[0]


def main(source, edited):
    before, after = Glb(Path(source)), Glb(Path(edited))
    assert before.indices == after.indices, "A numeric move changed triangle indices"
    assert before.attributes.keys() == after.attributes.keys()
    moved = []
    for i, (a, b) in enumerate(zip(before.attributes["POSITION"], after.attributes["POSITION"], strict=True)):
        if a != b:
            moved.append(i)
            assert b == (a[0], single(a[1] + .0005), a[2])
    assert moved == [100]
    assert all(before.attributes[k] == after.attributes[k] for k in ("TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"))
    normal_edits = sum(a != b for a, b in zip(before.attributes["NORMAL"], after.attributes["NORMAL"]))
    assert 0 < normal_edits < 100
    assert before.joint_names == after.joint_names and before.joint_parent_names() == after.joint_parent_names()
    assert max(dist(a, b) for a, b in zip(before.bind, after.bind)) < 1e-6
    assert all(before.texture(role) == after.texture(role) for role in ("baseColor", "normal"))
    assert before.primitive["extensions"]["FB_ngon_encoding"] == after.primitive["extensions"]["FB_ngon_encoding"]
    print(json.dumps({"sourceSha256": sha256(before.bytes).hexdigest(), "exactIndices": True, "moved": moved,
        "recalculatedNormals": normal_edits, "joints": len(after.joints), "texturesExact": True, "polygonMarkerExact": True}, indent=2))


def morph_split(source, edited):
    def read(path):
        glb = GlbDocument(Path(path))
        (mesh,) = glb.document["meshes"]
        (primitive,) = mesh["primitives"]
        attributes = {key: glb.accessor(value) for key, value in primitive["attributes"].items()}
        return attributes, glb.accessor(primitive["indices"]), glb.accessor(primitive["targets"][0]["POSITION"]), mesh["extras"]["targetNames"]

    a, _, source_deltas, source_names = read(source)
    b, indices, deltas, names = read(edited)
    assert len(b["POSITION"]) == 5 and len(indices) == 12
    for attr in ("POSITION", "TEXCOORD_0", "COLOR_0", "NORMAL"):
        assert a[attr] == b[attr][:-1]
    assert source_deltas == deltas[:-1] and source_names == names == ["Lift"]
    assert b["POSITION"][-1] == (.5, .5, 0)
    assert b["TEXCOORD_0"][-1] == (.5, .5)
    assert b["COLOR_0"][-1] == (.5, 0, .5)
    assert deltas[-1] == (0, 0, .25)
    assert sum(index == (4,) for index in indices) == 4
    print(json.dumps({"midpointColor": b["COLOR_0"][-1], "midpointMorphDelta": deltas[-1], "sourceAttributesExact": True}))


if __name__ == "__main__":
    if argv[1] == "--morph":
        morph_split(*argv[2:])
    else:
        main(*argv[1:])
