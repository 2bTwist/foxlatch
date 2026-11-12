"""The two builds of the add-on from one tree, and what each package holds.

The tree's extension/ is the public package exactly: its manifest names the
public id, and no file in it runs a session's code (Mozilla's policy on remote
code). The personal build adds extension-personal/scripts.js (eval, define,
call), and rewrites, in its package only and never in the tree, the add-on id
(the signer's own: see personal_id), its name, the
manifest's background scripts (scripts.js before background.js) and
files.json. The add-on knows its build from whether scripts.js is loaded, so
the package is the one source of truth. install.py writes the packages from
package_files, and the MCP server hashes package_files for the build the
add-on reports, so both builds hash as they ship.
"""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

# The personal build's add-on id, from <config dir>/personal-id (beside
# config.json) when it is there; installer, host and server all read it here,
# so the package and its digest agree.
DEFAULT_PERSONAL_ID = "foxlatch-personal@localhost"
GECKO_ID = re.compile(r"[A-Za-z0-9._+-]+@[A-Za-z0-9._-]+|\{[0-9A-Fa-f-]{36}\}")


def personal_id() -> str:
    from foxlatch import paths
    try:
        f = paths.resolve().config.parent / "personal-id"
        value = f.read_text().strip()
    except (OSError, paths.Unsupported):
        return DEFAULT_PERSONAL_ID
    if not GECKO_ID.fullmatch(value):
        raise ValueError(f"{f} must hold one add-on id (name@domain or {{uuid}}), not {value!r}")
    return value


PUBLIC_ID = "foxlatch@foxlatch"
BUILDS = {
    "public": {"name": "Foxlatch", "scripts": False},
    "personal": {"name": "Foxlatch (personal)", "scripts": True},
}


def gecko_id(build: str) -> str:
    """The add-on id of `build`. The personal one is read when asked, so a bad
    personal-id stops only what needs that build."""
    return PUBLIC_ID if build == "public" else personal_id()
# A zip entry's time; fixed, so a package is the same bytes every time it is built.
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
# The script path: only a build with scripts holds it, from this directory beside extension/.
SCRIPTS_DIR = "extension-personal"
SCRIPTS_FILE = "scripts.js"


def _swap(text: str, old: str, new: str, what: str) -> str:
    if text.count(old) != 1:
        raise ValueError(f"manifest.json must hold {old} exactly once to set the {what}")
    return text.replace(old, new)


def manifest_for(public_manifest: bytes, build: str) -> bytes:
    """manifest.json for `build`, from the tree's public one. Only the id, the
    name and, with scripts, the background scripts change, as text, so
    everything else is the tree's bytes."""
    if build == "public":
        return public_manifest
    pub, own = BUILDS["public"], BUILDS[build]
    text = public_manifest.decode()
    text = _swap(text, f'"id": {json.dumps(PUBLIC_ID)}', f'"id": {json.dumps(gecko_id(build))}', "id")
    text = _swap(text, f'"name": {json.dumps(pub["name"])}', f'"name": {json.dumps(own["name"])}', "name")
    if own["scripts"]:
        # After page.js, whose PAGE it adds to; before background.js, which finds it as it loads.
        text = _swap(text, '"page.js", "background.js"]', f'"page.js", {json.dumps(SCRIPTS_FILE)}, "background.js"]', "background scripts")
    return text.encode()


def shipped(extension_dir: Path) -> list[str]:
    """Every file under extension_dir the package holds: all of them but
    dotfiles (.DS_Store), so a new page can never be left out."""
    names = []
    for p in sorted(extension_dir.rglob("*")):
        rel = p.relative_to(extension_dir)
        if p.is_file() and not any(part.startswith(".") for part in rel.parts):
            names.append(rel.as_posix())
    return names


def package_files(extension_dir: Path, build: str) -> dict[str, bytes]:
    """The package for `build`: each shipped file's name and bytes."""
    if build not in BUILDS:
        raise ValueError(f"no build {build!r} (builds: {', '.join(BUILDS)})")
    files = {name: (extension_dir / name).read_bytes() for name in shipped(extension_dir)}
    if SCRIPTS_FILE in files:
        raise ValueError(f"{extension_dir} holds {SCRIPTS_FILE}; it belongs in {SCRIPTS_DIR}/, outside the public package")
    files["manifest.json"] = manifest_for(files["manifest.json"], build)
    if BUILDS[build]["scripts"]:
        files[SCRIPTS_FILE] = (extension_dir.parent / SCRIPTS_DIR / SCRIPTS_FILE).read_bytes()
        listed = json.loads(files["files.json"])
        files["files.json"] = (json.dumps(sorted([*listed, SCRIPTS_FILE]), indent=1) + "\n").encode()
    return files


def _digested(name: str, data: bytes) -> bytes:
    """A file as the digest reads it: manifest.json as its JSON with keys
    sorted and no spacing, since Mozilla's signing writes that file out
    again laid out its own way; every other file byte for byte."""
    if name != "manifest.json":
        return data
    return json.dumps(json.loads(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(files: dict[str, bytes], names: list[str]) -> str:
    """What background.js addonCode reports: SHA-256 over each file
    files.json names, in its order, as name NUL bytes NUL (manifest.json's
    bytes per _digested); 16 hex digits."""
    h = hashlib.sha256()
    for name in names:
        h.update(name.encode() + b"\0" + _digested(name, files[name]) + b"\0")
    return h.hexdigest()[:16]


def package_digest(extension_dir: Path, build: str) -> str | None:
    """The digest the add-on of `build`, packaged from extension_dir, reports;
    None if the files cannot be read or files.json names one it lacks."""
    try:
        files = package_files(extension_dir, build)
        names = json.loads(files["files.json"])
        if not (isinstance(names, list) and all(isinstance(n, str) for n in names)):
            return None
        return digest(files, names)
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_zip(files: dict[str, bytes], dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, files[name])
    tmp.replace(dest)
