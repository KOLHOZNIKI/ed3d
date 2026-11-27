"""Verify published diagnostic GLB data and prepare the FBX verification projects."""

from argparse import ArgumentParser
from functools import cache
import json
from math import acos, dist, sin, sqrt
from pathlib import Path
from shutil import copy2
import sys

sys.path.insert(0, str(Path(__file__).parent / "e00"))
from fixtures import copy_bundle
from inspect_glb import Glb, multiply, point, transform


OUT = Path("test-results/e11")


def mix(a, b, t, rotation):
    if rotation:
        dot = sum(x * y for x, y in zip(a, b))
        if dot < 0:
            b, dot = tuple(-value for value in b), -dot
        if dot < .9995:
            angle = acos(min(1, dot))
            return tuple((x * sin((1 - t) * angle) + y * sin(t * angle)) / sin(angle) for x, y in zip(a, b))
    value = tuple(x + (y - x) * t for x, y in zip(a, b))
    if rotation:
        length = sqrt(sum(x * x for x in value))
        return tuple(x / length for x in value)
    return value


def clip_data(model, animation):
    channels = {}
    duration = 0
    for channel in animation["channels"]:
        target = channel["target"]
        sampler = animation["samplers"][channel["sampler"]]
        assert sampler.get("interpolation", "LINEAR") == "LINEAR"
        times = [time for time, in model.accessor(sampler["input"])]
        values = model.accessor(sampler["output"])
        assert len(times) == len(values) and all(a < b for a, b in zip(times, times[1:]))
        if target["path"] == "rotation":
            assert max(abs(sum(x * x for x in q) - 1) for q in values) < 1e-6
        duration = max(duration, times[-1])
        channels.setdefault(target["node"], {})[target["path"]] = (times, values)
    return duration, channels


def frame(model, channels, time):
    @cache
    def world(index):
        node = dict(model.document["nodes"][index])
        if index in channels:
            node.pop("matrix", None)
        for prop, (times, values) in channels.get(index, {}).items():
            if time <= times[0]:
                node[prop] = values[0]
            elif time >= times[-1]:
                node[prop] = values[-1]
            else:
                start = max(i for i, key in enumerate(times) if key < time)
                fraction = (time - times[start]) / (times[start + 1] - times[start])
                node[prop] = mix(values[start], values[start + 1], fraction, prop == "rotation")
        local = transform(node)
        return multiply(world(model.parents[index]), local) if index in model.parents else local

    matrices = [multiply(world(joint), bind) for joint, bind in zip(model.joints, model.bind)]
    attributes = model.attributes
    samples = []
    for index in range(0, len(attributes["POSITION"]), 17):
        vertex = attributes["POSITION"][index]
        parts = [(point(matrices[joint], vertex), weight) for joint, weight in
                 zip(attributes["JOINTS_0"][index], attributes["WEIGHTS_0"][index]) if weight]
        samples.append(tuple(sum(position[k] * weight for position, weight in parts) for k in range(3)))
    return world(model.joints[model.joint_names.index("Hips")])[12:15], samples


def glb():
    base, edited = Glb(OUT / "tripo-rest.glb"), Glb(OUT / "tripo-published.glb")
    assert base.bytes == (OUT / "tripo-preview.glb").read_bytes()
    assert base.attributes == edited.attributes and base.indices == edited.indices and base.bind == edited.bind
    assert base.joint_names == edited.joint_names and base.joint_parent_names() == edited.joint_parent_names()
    assert base.joint_world_matrices() == edited.joint_world_matrices()
    for role in ("baseColor", "normal"):
        a, b = base.texture(role), edited.texture(role)
        assert (a[0], a[2], a[3]) == (b[0], b[2], b[3])
    assert not base.document.get("animations")
    rest = base.joint_world_matrices()[base.joint_names.index("Hips")][12:15]
    clips = edited.document["animations"]
    assert [item["name"] for item in clips] == ["Diagnostic_Squat_Corrected", "Diagnostic_Walk_Travel"]
    report = {}
    for item in clips:
        duration, tracks = clip_data(edited, item)
        assert set(edited.joints) == set(tracks) and .8 <= duration <= 3
        start, first = frame(edited, tracks, 0)
        middle, half = frame(edited, tracks, duration / 2)
        end, _ = frame(edited, tracks, duration)
        movement = max(dist(a, b) for a, b in zip(first, half))
        assert movement > .08
        offset = dist(start, rest)
        assert abs(offset - .035) < 1e-6
        up = [(a - b) / offset for a, b in zip(start, rest)]
        drop = sum((a - b) * direction for a, b, direction in zip(start, middle, up))
        if "Squat" in item["name"]:
            assert drop > .08 and dist(start, end) < 1e-6
        else:
            assert abs(sum((a - b) * direction for a, b, direction in zip(start, end, up))) < 1e-6 and dist(start, end) > .25
        report[item["name"]] = {"duration": duration, "tracks": len(item["channels"]), "maxSampledDisplacementMeters": movement,
                                "hipDropMeters": drop, "rootTravelMeters": dist(start, end), "sampledVertices": len(first)}
    (OUT / "glb.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def unity(version):
    project = OUT / f"unity-{version}"
    assets = project / "Assets" / "Fixtures"
    copy_bundle(OUT / "humanoid.fbx", assets / "original")
    copy_bundle(OUT / "humanoid-before-weights.zip", assets / "preview")
    copy_bundle(OUT / "humanoid-published.zip", assets / "published")
    editors, settings, packages = (project / "Assets" / "Editor", project / "ProjectSettings", project / "Packages")
    for directory in (editors, settings, packages):
        directory.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("E11Probe.cs"), editors)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{module}": "1.0.0" for module in ("animation", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--unity")
    args = parser.parse_args()
    unity(args.unity) if args.unity else glb()
