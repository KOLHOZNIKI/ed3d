"""Package the static Release build and its bundled licenses for local hosting."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import re


def package():
    build, dependencies = Path("dist"), Path("node_modules")
    if not (build / "offline-sw.js").is_file():
        raise SystemExit("Build Release before packaging it.")
    result = Path("test-results/e12/AssetFixer-release.zip")
    result.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(result, "w", ZIP_DEFLATED) as archive:
        for path in sorted(build.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(build).as_posix())
        archive.write("LICENSE")
        for package_name in ("three", "fflate", "fast-png", "iobuffer", "@comfyorg/fbx-exporter-three", "meshoptimizer"):
            filename = "LICENSE.md" if package_name == "meshoptimizer" else "LICENSE"
            archive.write(dependencies / package_name / filename, f"licenses/{package_name.split('/')[-1]}.txt")
        template = (dependencies / "three/LICENSE").read_text(encoding="utf-8")
        for name, notice in (("xatlas", "2018-2020 Jonathan Young"), ("xatlas-wasm", "2026 Alexander Klingenbeck")):
            archive.writestr(f"licenses/{name}.txt", re.sub(r"^Copyright .*", f"Copyright (c) {notice}", template, count=1, flags=re.M))
        mikk = (dependencies / "three/examples/jsm/libs/mikktspace.module.js").read_text(encoding="utf-8")
        archive.writestr("licenses/MikkTSpace.txt", mikk.split("*/", 1)[0] + "*/\n")
    with ZipFile(result) as archive:
        if archive.testzip() or "index.html" not in archive.namelist():
            raise SystemExit("Release ZIP verification failed.")
    print(result.resolve())


if __name__ == "__main__":
    package()
