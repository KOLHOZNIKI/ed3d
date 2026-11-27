"""Check the actual indexed boundaries and cap triangles in the E05 exports."""

from collections import Counter
from math import isclose
from pathlib import Path
from sys import argv
import json

from e00.inspect_glb import GlbDocument


def read(path):
    document = GlbDocument(path)
    result = {}
    for node in document.document["nodes"]:
        if "mesh" not in node:
            continue
        (primitive,) = document.document["meshes"][node["mesh"]]["primitives"]
        attrs = {key: document.accessor(value) for key, value in primitive["attributes"].items()}
        ids = [index for (index,) in document.accessor(primitive["indices"])]
        result[node["name"]] = (attrs, list(zip(ids[::3], ids[1::3], ids[2::3])), node.get("extras", {}))
    return result


def edges(triangles):
    counter = Counter(tuple(sorted((a, b))) for tri in triangles for a, b in zip(tri, (*tri[1:], tri[0])))
    assert max(counter.values()) <= 2
    return {edge for edge, count in counter.items() if count == 1}


def turn(a, b, p):
    return (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])


def proper_cross(a, b, c, d):
    return turn(a, b, c) * turn(a, b, d) < -1e-12 and turn(c, d, a) * turn(c, d, b) < -1e-12


def inside(p, segments):
    inside = False
    x, y = p
    for a, b in segments:
        if abs(turn(a, b, p)) < 1e-8 and min(a[0], b[0])-1e-8 <= x <= max(a[0], b[0])+1e-8 and min(a[1], b[1])-1e-8 <= y <= max(a[1], b[1])+1e-8:
            return True
        if (a[1] > y) != (b[1] > y) and x < a[0] + (b[0]-a[0]) * (y-a[1]) / (b[1]-a[1]):
            inside = not inside
    return inside


def compare(a, b):
    before_attrs, before, _ = a
    after_attrs, after, _ = b
    assert before == after[:len(before)] and before_attrs.keys() == after_attrs.keys()
    for key, values in before_attrs.items():
        assert values == after_attrs[key][:len(values)], key
    return after[len(before):]


def main(corpus, output):
    corpus, output = Path(corpus), Path(output)
    bottle, = read(corpus / "f04_bottle.glb").values()
    fixed, = read(output / "bottle-repaired.glb").values()
    assert len(compare(bottle, fixed)) == 2 and fixed[0]["POSITION"] == bottle[0]["POSITION"]
    mouth = {tuple(sorted((v, 48 + (v-47) % 12))) for v in range(48, 60)}
    assert edges(fixed[1]) == mouth and set(fixed[2]["protectedLoop"]) == set(range(48, 60))
    original = read(corpus / "f03_boundaries.glb")
    result = read(output / "contours-repaired.glb")
    planar = compare(original["ConcavePlanar"], result["ConcavePlanar"])
    planar_points = result["ConcavePlanar"][0]["POSITION"]
    assert len(planar) == 6 and not edges(result["ConcavePlanar"][1])
    assert planar_points == original["ConcavePlanar"][0]["POSITION"]
    border = [p[:2] for p in planar_points[8:16]]
    segments = list(zip(border, border[1:] + border[:1]))
    area = abs(sum(a[0]*b[1] - b[0]*a[1] for a, b in segments)) * .5
    cap_area = 0
    for indices in planar:
        assert set(indices) <= set(range(8, 16))
        triangle = [planar_points[i][:2] for i in indices]
        cap_area += abs(turn(*triangle)) * .5
        for a, b in zip(triangle, triangle[1:] + triangle[:1]):
            assert inside(((a[0]+b[0])/2, (a[1]+b[1])/2), segments)
            assert not any(proper_cross(a, b, c, d) for c, d in segments)
    assert isclose(area, cap_area, abs_tol=1e-7)
    fan = compare(original["NonPlanar"], result["NonPlanar"])
    fan_points = result["NonPlanar"][0]["POSITION"]
    center = len(fan_points) - 1
    assert len(fan) == 8 and all(center in triangle for triangle in fan) and not edges(result["NonPlanar"][1])
    assert len(fan_points) == len(original["NonPlanar"][0]["POSITION"]) + 1
    print(json.dumps({"protectedMouthEdges": len(mouth), "planarTriangles": len(planar),
        "planarArea": area, "planarPatchArea": cap_area, "fanTriangles": len(fan), "fanCenter": fan_points[center]}, indent=2))


if __name__ == "__main__":
    main(*argv[1:])
