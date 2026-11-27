"""Independently verify the E12 plate, character and FBX animation exports."""

from argparse import ArgumentParser
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from zipfile import ZipFile

from e00.fixtures import copy_bundle
from e00.inspect_glb import Glb, compare


def fbx(path, dest):
    copy_bundle(path, dest)
    model, = dest.rglob("*.fbx")
    return model


def run(executable, *files):
    return json.loads(subprocess.check_output([executable, *files], text=True, encoding="utf-8"))


def verify(tripo, browser):
    out = Path("test-results/e12")
    exports = out / browser
    local = exports / "independent-inputs"
    plate_original = tripo / "ceramic plate 3d model.zip"
    plate_export = exports / "tripo-plate.zip"
    plate = run(Path("test-results/e00/ufbx/inspect_fbx.exe"),
                fbx(plate_original, local / "plate-original"), fbx(plate_export, local / "plate-export"))
    with ZipFile(plate_original) as source, ZipFile(plate_export) as target:
        manifest = json.loads(target.read("manifest.json"))
        for texture in manifest["textures"]:
            assert texture["source"] and source.read(texture["source"]) == target.read(texture["file"])
        report = json.loads(target.read("report.json"))
        assert report["originals"][0]["sha256"] == sha256(plate_original.read_bytes()).hexdigest()
    glb = compare(Glb(tripo / "man character 3d model.glb"), Glb(exports / "tripo-character.glb"))
    e11 = Path("test-results/e11")
    character = run(e11 / "e11-fbx.exe", e11 / "humanoid.fbx",
                    fbx(e11 / "humanoid-before-weights.zip", local / "rig-preview"),
                    fbx(e11 / "humanoid-published.zip", local / "rig-published"))
    result = {"plate": plate, "characterGlb": glb, "characterFbx": character}
    (exports / "independent.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("tripo", type=Path, nargs="?", default=Path("D:/downloads/Tripo"))
    parser.add_argument("--browser", choices=("chrome", "edge"), default="chrome")
    arguments = parser.parse_args()
    verify(arguments.tripo, arguments.browser)
