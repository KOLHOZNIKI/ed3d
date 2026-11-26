"""Assemble a disposable Unity project from private local E00 fixtures."""

from pathlib import Path, PurePosixPath
from shutil import copy2
from zipfile import ZipFile
import argparse
import json


def copy_bundle(source, target):
    target.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".fbx":
        copy2(source, target / source.name)
        return
    with ZipFile(source) as archive:
        for item in archive.infolist():
            name = item.filename.replace("\\", "/")
            path = PurePosixPath(name)
            if path.is_absolute() or any(part == ".." or ":" in part for part in path.parts):
                raise ValueError(f"Invalid bundle path: {name}")
            if item.is_dir() or path.suffix.lower() not in (".fbx", ".png", ".jpg", ".jpeg"):
                continue
            destination = target.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(item))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tripo_dir", type=Path)
    parser.add_argument("unity_version")
    parser.add_argument("--animation", type=Path)
    parser.add_argument("--real-animation", type=Path)
    parser.add_argument("--edited", action="store_true")
    parser.add_argument("--unwrap", action="store_true")
    parser.add_argument("--rebake", action="store_true")
    args = parser.parse_args()

    results = Path("test-results/e00")
    project = results / (
        f"unity-{args.unity_version}"
        + ("-edited" if args.edited else "")
        + ("-animated" if args.real_animation else "")
        + ("-atlas" if args.unwrap else "")
        + ("-bake" if args.rebake else "")
    )
    cases = [
        ("static", args.tripo_dir / "ceramic plate 3d model.zip", "ceramic_plate_3d_model_e00.zip"),
        ("skinned", args.tripo_dir / "tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b.zip",
         "tripo_convert_8b04a473-804b-41a0-ab47-e84ae233629b_e00.zip"),
    ]
    if args.animation:
        cases.append(("animated", args.animation, "animated_fixture_e00.zip"))
    if args.real_animation:
        cases.append(("real-animated", args.real_animation, f"{args.real_animation.stem}_e00.zip"))
    edits = {}
    if args.edited:
        edits = json.loads(Path(__file__).with_name("position-edits.json").read_text(encoding="utf-8"))
    for name, source, exported in cases:
        if args.rebake and name in ("static", "skinned"):
            case = project / "Assets" / "Fixtures" / name
            baked_export = results / "exports" / exported.replace(".zip", "_baked.zip")
            copy_bundle(source, case / "original")
            copy_bundle(baked_export, case / "exported")
            copy_bundle(results / "exports" / exported.replace(".zip", "_atlas.zip"), case / "reference")
            copy_corner_map(baked_export, case)
            continue
        case = project / "Assets" / "Fixtures" / name
        copy_bundle(source, case / "original")
        copy_bundle(results / "exports" / exported, case / "exported")
        if args.unwrap and name in ("static", "skinned"):
            atlas_case = project / "Assets" / "Fixtures" / f"{name}-atlas"
            atlas_export = results / "exports" / exported.replace(".zip", "_atlas.zip")
            copy_bundle(source, atlas_case / "original")
            copy_bundle(atlas_export, atlas_case / "exported")
            copy_corner_map(atlas_export, atlas_case)
        if name in edits:
            edited_case = project / "Assets" / "Fixtures" / f"{name}-edited"
            copy_bundle(source, edited_case / "original")
            edited_export = exported.replace(".zip", "_edited.zip")
            copy_bundle(results / "exports" / edited_export, edited_case / "exported")
            (edited_case / "position-edit.json").write_text(json.dumps(edits[name]), encoding="utf-8")

    editors = project / "Assets" / "Editor"
    editors.mkdir(parents=True, exist_ok=True)
    copy2(Path(__file__).with_name("FbxProbe.cs"), editors)
    if args.rebake:
        for filename in ("TextureBakeProbe.cs", "TextureBakeProbe.shader"):
            copy2(Path(__file__).with_name(filename), editors)
    settings = project / "ProjectSettings"
    settings.mkdir(exist_ok=True)
    (settings / "ProjectVersion.txt").write_text(f"m_EditorVersion: {args.unity_version}\n", encoding="utf-8")
    packages = project / "Packages"
    packages.mkdir(exist_ok=True)
    modules = {f"com.unity.modules.{module}": "1.0.0" for module in ("animation", "imageconversion", "jsonserialize")}
    (packages / "manifest.json").write_text(json.dumps({"dependencies": modules}), encoding="utf-8")
    print(project.resolve())


def copy_corner_map(bundle, target):
    with ZipFile(bundle) as archive:
        corner_map = "uv-atlas-source-corners.bin"
        (target / corner_map).write_bytes(archive.read(corner_map))


if __name__ == "__main__":
    main()
