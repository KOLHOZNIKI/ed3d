"""Check edited GLB weights independently and prepare Unity FBX verification projects."""

from argparse import ArgumentParser
from functools import cache
import json
from math import dist
from pathlib import Path
from shutil import copy2
import sys

sys.path.insert(0, str(Path(__file__).parent / "e00"))
from fixtures import copy_bundle
from inspect_glb import Glb, multiply, point, transform


OUT = Path("test-results/e10")
FIXTURES = Path("tools/e00/fixtures")
CASES = {"fingers": OUT / "fingers.fbx", "wide": FIXTURES / "f13_wide_skin.fbx"}


def prepare(project):
    assets = project / "Assets" / "Fixtures"
    for case, source in CASES.items():
        copy_bundle(source, assets / case / "original")
        copy_bundle(OUT / f"{case}-{'smooth' if case == 'fingers' else 'converted'}.zip", assets / case / "edited")
        copy_bundle(OUT / f"{case}-undone.zip", assets / case / "undone")


def unity(version):
    project = OUT / f"unity-{version}"
    prepare(project)
    editors, settings, packages = (project / "Assets" / "Editor", project / "ProjectSettings", project / "Packages")
    for directory in (editors, settings, packages):
        directory.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("E10Probe.cs"), editors)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


def weights(glb, vertex):
    return {glb.joint_names[j]: w for j, w in zip(glb.attributes["JOINTS_0"][vertex], glb.attributes["WEIGHTS_0"][vertex]) if w > 0}


def sample(glb, row):
    doc = glb.document
    clip, = doc["animations"]
    channel, = clip["channels"]
    sampler = clip["samplers"][channel["sampler"]]
    animated = channel["target"]["node"]
    assert clip["name"] == "TorsoSweep" and doc["nodes"][animated]["name"] == "Spine"
    assert channel["target"]["path"] == "rotation" and sampler.get("interpolation", "LINEAR") == "LINEAR"
    times, values = glb.accessor(sampler["input"]), glb.accessor(sampler["output"])
    rotation = values[times.index((0.5,))]

    @cache
    def world(index):
        local = dict(doc["nodes"][index])
        if index == animated:
            local["rotation"] = rotation
        matrix = transform(local)
        return multiply(world(glb.parents[index]), matrix) if index in glb.parents else matrix

    vertex = glb.attributes["POSITION"][24]
    contributions = [(weight, point(multiply(world(joint), bind), vertex)) for joint, bind, name in
                     zip(glb.joints, glb.bind, glb.joint_names) if (weight := row.get(name))]
    return tuple(sum(weight * position[i] for weight, position in contributions) for i in range(3))


def check_glb():
    before, after = Glb(FIXTURES / "corpus/f11_wide_torso.glb"), Glb(OUT / "torso-replaced.glb")
    assert before.indices == after.indices and before.joint_names == after.joint_names and before.bind == after.bind
    assert before.joint_parent_names() == after.joint_parent_names()
    for key in before.attributes.keys() - {"JOINTS_0", "WEIGHTS_0"}:
        assert before.attributes[key] == after.attributes[key]
    changes = [i for i in range(len(before.attributes["POSITION"])) if weights(before, i) != weights(after, i)]
    assert changes == [24]
    expected = {"Pelvis": .21875, "Spine": .3875, "Chest": .19375, "LeftArm": .2}
    observed = weights(after, 24)
    assert expected.keys() == observed.keys()
    error = max(abs(weight - observed[name]) for name, weight in expected.items())
    assert error < 1e-7
    prediction = sample(before, expected)
    output = sample(after, observed)
    delta = dist(output, sample(before, weights(before, 24)))
    assert dist(prediction, output) < 1e-6 and delta > .01
    report = {"changedVertices": changes, "lockedPelvis": observed["Pelvis"], "weights": observed, "maxWeightError": error,
              "deformationChangeMeters": delta, "deformationPredictionErrorMeters": dist(prediction, output)}
    (OUT / "glb.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--unity")
    parser.add_argument("--unpack", action="store_true")
    args = parser.parse_args()
    if args.unity:
        unity(args.unity)
    elif args.unpack:
        prepare(OUT / "fbx")
    else:
        check_glb()
