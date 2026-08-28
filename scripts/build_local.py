#!/usr/bin/env python3
from pathlib import Path
import json, re, shutil, subprocess, zipfile, hashlib
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BUILD = None
RUNTIME = None
TMP = ROOT / ".local-build"

ORDER = [
    "src/config.ts",
    "src/core/SecureStore.ts",
    "src/core/AuthManager.ts",
    "src/core/AttachmentDetector.ts",
    "src/core/Metadata.ts",
    "src/core/PdfVerifier.ts",
    "src/core/QueueStore.ts",
    "src/core/JLSSClient.ts",
    "src/core/NativeFullText.ts",
    "src/core/PdfImporter.ts",
    "src/core/CollectionScanner.ts",
    "src/core/FlowEngine.ts",
    "src/core/AutoWatcher.ts",
    "src/ui/TaskManager.ts",
    "src/ui/AuthWindow.ts",
    "src/ui/Menus.ts",
    "src/addon.ts",
    "src/index.ts",
]

def clean_ts(text: str) -> str:
    lines = []
    for line in text.splitlines():
        if line.lstrip().startswith("import "):
            continue
        lines.append(re.sub(r"^(\s*)export\s+", r"\1", line))
    return "\n".join(lines)

def fill(text: str, mapping: dict[str,str]) -> str:
    for k,v in mapping.items():
        text = text.replace(f"__{k}__", v)
    return text

def validate_ui_sources():
    for name in ["task-manager.xhtml", "auth-window.xhtml"]:
        ET.parse(ROOT / "addon" / "content" / name)
    for name in ["task-manager.js", "auth-window.js"]:
        subprocess.run(["node", "--check", str(ROOT / "addon" / "content" / name)], check=True, cwd=ROOT)

def main():
    global BUILD, RUNTIME
    pkg = json.loads((ROOT / "package.json").read_text())
    cfg = pkg["config"]
    BUILD = ROOT / f"build-{pkg['version']}"
    RUNTIME = BUILD / "content" / "scripts" / "fulltextflow.js"
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.rmtree(TMP, ignore_errors=True)
    (BUILD / "content" / "scripts").mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)

    validate_ui_sources()

    declarations = (ROOT / "typings" / "runtime.d.ts").read_text()
    chunks = [declarations, "\n(() => {\n"]
    for rel in ORDER:
        chunks.append(f"\n// ---- {rel} ----\n")
        chunks.append(clean_ts((ROOT / rel).read_text()))
        chunks.append("\n")
    chunks.append("\n})();\n")
    combined = TMP / "fulltextflow-combined.ts"
    combined.write_text("".join(chunks))

    subprocess.run([
        "tsc", str(combined),
        "--target", "ES2022",
        "--module", "none",
        "--lib", "ES2022,DOM",
        "--skipLibCheck",
        "--outFile", str(RUNTIME),
    ], check=True, cwd=ROOT)
    subprocess.run(["node", "--check", str(RUNTIME)], check=True, cwd=ROOT)

    mapping = {
        "addonName": cfg["addonName"],
        "buildVersion": pkg["version"],
        "description": pkg["description"],
        "homepage": pkg["homepage"],
        "author": pkg["author"],
        "addonID": cfg["addonID"],
        "addonRef": cfg["addonRef"],
        "addonInstance": cfg["addonInstance"],
        "updateURL": "https://github.com/PracticeEarnestly/zotero-fulltext-flow/releases/latest/download/update.json",
    }
    bootstrap = fill((ROOT / "addon" / "bootstrap.js").read_text(), mapping)
    manifest = fill((ROOT / "addon" / "manifest.json").read_text(), mapping)
    json.loads(manifest)
    (BUILD / "bootstrap.js").write_text(bootstrap)
    (BUILD / "manifest.json").write_text(manifest)
    shutil.copy2(ROOT / "addon" / "prefs.js", BUILD / "prefs.js")
    for name in ["task-manager.xhtml", "task-manager.js", "auth-window.xhtml", "auth-window.js"]:
        shutil.copy2(ROOT / "addon" / "content" / name, BUILD / "content" / name)

    out = ROOT / f"fulltextflow-{pkg['version']}.xpi"
    if out.exists(): out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(BUILD.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(BUILD).as_posix())
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    (ROOT / f"fulltextflow-{pkg['version']}.xpi.sha256").write_text(f"{digest}  {out.name}\n")
    print(out)
    print(digest)

if __name__ == "__main__":
    main()
