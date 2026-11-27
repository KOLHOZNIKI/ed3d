"""Verify the Tripo rig export and prepare a disposable Unity project for the F10 exports."""

from argparse import ArgumentParser
from hashlib import sha256
import json
from math import dist
from pathlib import Path
from shutil import copy2
import sys

sys.path.insert(0, str(Path(__file__).parent / "e00"))
from fixtures import copy_bundle
from inspect_glb import Glb, multiply, point, transform


OUT = Path("test-results/e09")


def check_glb(source):
    before, after = Glb(source), Glb(OUT / "tripo-reset.glb")
    assert before.attributes == after.attributes and before.indices == after.indices
    assert before.joint_names == after.joint_names and before.joint_parent_names() == after.joint_parent_names()
    assert len(after.joints) == 67
    for role in ("baseColor", "normal"):
        left, right = before.texture(role), after.texture(role)
        assert (left[0], left[2], left[3]) == (right[0], right[2], right[3])
    assert after.bytes == (OUT / "tripo-posed.glb").read_bytes()
    names = after.joint_names
    world = dict(zip(names, after.joint_world_matrices()))
    left, right = world["Left_UpperArm"][12:15], world["Right_UpperArm"][12:15]
    mirror_error = dist((-left[0], *left[1:]), right)
    assert mirror_error <= 1e-6
    nodes = after.document["nodes"]
    mesh_index = nodes.index(after.mesh_node)
    mesh_world = transform(after.mesh_node)
    while mesh_index in after.parents:
        mesh_index = after.parents[mesh_index]
        mesh_world = multiply(transform(nodes[mesh_index]), mesh_world)
    rest_error = max(dist(point(mesh_world, a), b) for a, b in zip(after.attributes["POSITION"], after.deformed()))
    assert rest_error <= 1e-5
    report = {"triangles": len(after.indices) // 3, "joints": len(after.joints), "sameAttributes": True,
              "sameEmbeddedImages": True, "mirrorErrorMeters": mirror_error, "restErrorMeters": rest_error,
              "sha256WithAndWithoutManualPose": sha256(after.bytes).hexdigest()}
    (OUT / "glb.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


def unity_project(version):
    project = OUT / f"unity-{version}"
    fixtures = project / "Assets" / "Fixtures"
    copy_bundle(Path("tools/e00/fixtures/shared_skin.fbx"), fixtures / "original")
    for case in ("undone", "moved", "renamed", "deleted"):
        copy_bundle(OUT / f"shared-{case}.zip", fixtures / case)
    editors, settings, packages = (project / "Assets" / "Editor", project / "ProjectSettings", project / "Packages")
    for directory in (editors, settings, packages):
        directory.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("E09Probe.cs"), editors)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {version}\n", encoding="utf-8")
    modules = {f"com.unity.modules.{name}": "1.0.0" for name in ("animation", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--unity")
    parser.add_argument("--tripo", type=Path, default=Path("D:/downloads/Tripo/man character 3d model.glb"))
    args = parser.parse_args()
    if args.unity:
        unity_project(args.unity)
    else:
        check_glb(args.tripo)
