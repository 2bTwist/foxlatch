"""Installs, checks and removes Foxlatch for this user; install.sh runs it
with the Python it found (--python). Paths come from paths.py, packages
from build.py, and the config check from the host's own validator, so
nothing here keeps a second copy of them.

  install.py --python PY [--personal] [--place] [--agents]
                                           install (public build by default);
                                           --place first copies this release into
                                           the app directory and installs from there
                                           (get.sh); --agents adds the MCP server to
                                           the agent CLIs on PATH
  install.py --python PY --uninstall [--purge]
  install.py --python PY --doctor

FOXLATCH_DIST (tests) packages into another directory; FOXLATCH_PLATFORM
(tests) installs another platform's layout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from foxlatch import build as builds  # noqa: E402
from foxlatch import paths  # noqa: E402

PROTOCOL = 2  # host.py and server.py PROTOCOL
MIN_PYTHON = (3, 11)
HOST = ROOT / "host" / "host.py"
SERVER = ROOT / "mcp" / "server.py"
DEFAULT_CONFIG = '{\n  "deny": [],\n  "protect": [],\n  "exclusive": []\n}\n'


def say(*lines: str) -> None:
    for line in lines:
        print(line, flush=True)


def private(d: Path) -> None:
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(d, 0o700)


def write(path: Path, text: str, mode: int) -> None:
    """Replaces path whole (temp file, rename), with this mode."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def launcher_text(python: str) -> str:
    return ("#!/bin/sh\n"
            "# Foxlatch native host, as Firefox starts it. Written by install.sh; run it again to change it.\n"
            f"exec {shlex.quote(python)} -I {shlex.quote(str(HOST))} \"$@\"\n")


def launcher_target(launcher: Path) -> tuple[str, str] | None:
    """The interpreter and host.py a launcher written by launcher_text runs."""
    try:
        for line in launcher.read_text().splitlines():
            if line.startswith("exec "):
                argv = shlex.split(line)
                return argv[1], argv[3]
    except (OSError, ValueError, IndexError):
        pass
    return None


def mcp_setup(python: str) -> list[str]:
    toml = lambda s: json.dumps(s)  # a JSON string is a TOML basic string  # noqa: E731
    return [
        "Connect an agent (each session starts its own server):",
        "  Claude Code:",
        f"    claude mcp add --scope user foxlatch -- {shlex.quote(python)} {shlex.quote(str(SERVER))}",
        "  Codex, in ~/.codex/config.toml:",
        "    [mcp_servers.foxlatch]",
        f"    command = {toml(python)}",
        f"    args = [{toml(str(SERVER))}]",
    ]


# ---------- agents ----------

# Each agent's own CLI, so its config format stays its business. add refuses
# a name it already has, so remove goes first (and fails harmlessly if absent).
AGENTS = {
    "claude": (["mcp", "remove", "--scope", "user", "foxlatch"], ["mcp", "add", "--scope", "user", "foxlatch", "--"]),
    "codex": (["mcp", "remove", "foxlatch"], ["mcp", "add", "foxlatch", "--"]),
}


def register_agents(python: str) -> tuple[list[str], bool]:
    """Adds this install's MCP server to each agent CLI on PATH; says what it
    did, and whether every one took it."""
    done, ok = [], True
    for cli, (remove, add) in AGENTS.items():
        exe = shutil.which(cli)
        if not exe:
            continue
        subprocess.run([exe, *remove], capture_output=True)
        command = [exe, *add, python, str(SERVER)]
        r = subprocess.run(command, capture_output=True, text=True)
        if r.returncode == 0:
            done.append(f"  {cli}: added foxlatch")
            continue
        ok = False
        detail = (r.stderr or r.stdout).strip().splitlines()
        done += [f"  {cli}: could not add foxlatch ({detail[-1] if detail else f'exit {r.returncode}'}); to add it yourself:",
                 f"    {shlex.join([cli, *command[1:]])}"]
    return done, ok


# ---------- install ----------

class Refused(Exception):
    """install.sh stops, having changed nothing, and says why."""


def host_running(run: Path) -> bool:
    """Whether a host is alive: a registry entry in `run` names a live pid."""
    for f in run.glob("*.json"):
        try:
            os.kill(int(json.loads(f.read_text())["pid"]), 0)
            return True
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return False


def migrate(p: paths.Paths) -> list[str]:
    """macOS installs from before the rename kept config.json and approvals/
    in ~/Library/Application Support/firefox-driver and registered the host
    as firefox_driver. Moves them here unless this install has its own, and
    removes the old registration; says what it did."""
    done = []
    old = p.legacy_state
    if old and old.is_dir() and host_running(old / "run"):
        raise Refused(f"Firefox is running a Foxlatch host from before the rename, which still writes {old / 'approvals'}; "
                      "moved now, an approval you forget before Firefox restarts would come back. "
                      "Quit Firefox, then run install.sh again.")
    if old and old.is_dir():
        if (old / "config.json").is_file() and not p.config.exists():
            p.config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.replace(old / "config.json", p.config)
            done.append(f"moved {old / 'config.json'} to {p.config}")
        if (old / "approvals").is_dir() and not (p.approvals.exists() and any(p.approvals.iterdir())):
            if p.approvals.exists():
                p.approvals.rmdir()
            p.approvals.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.replace(old / "approvals", p.approvals)
            done.append(f"moved {old / 'approvals'} to {p.approvals}")
        if done:
            done.append(f"left {old} (anything else in it is no longer used)")
    if p.legacy_manifest and p.legacy_manifest.exists():
        p.legacy_manifest.unlink()
        done.append(f"removed the old native host registration {p.legacy_manifest}; an add-on built before "
                    "the rename cannot reach Foxlatch until you install this build")
    return done


# What a release runs; --place copies these and nothing else.
APP_FILES = ("host", "mcp", "foxlatch", "extension", "extension-personal", "install.sh", "LICENSE", "README.md", "SECURITY.md")


def is_app(d: Path) -> bool:
    return (d / "install.sh").is_file() and (d / "foxlatch" / "install.py").is_file()


def place(p: paths.Paths) -> None:
    """Copies this release into p.app, replacing the Foxlatch already there
    (never anything else). Hosts already running keep the code they loaded."""
    app = p.app
    if app.is_symlink() or (app.exists() and not is_app(app)):
        raise Refused(f"{app} exists and is not a Foxlatch install; move it aside, then run this again.")
    app.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    new, old = app.with_name(".app.new"), app.with_name(".app.old")
    if not app.exists() and is_app(old):
        os.replace(old, app)  # a run cut off between the two moves below left the only whole copy here
    for d in (new, old):
        shutil.rmtree(d, ignore_errors=True)
    new.mkdir(mode=0o700)
    for name in APP_FILES:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, new / name, ignore=shutil.ignore_patterns("__pycache__"))
        elif src.is_file():
            shutil.copy2(src, new / name)
    if app.exists():
        os.replace(app, old)
    os.replace(new, app)
    shutil.rmtree(old, ignore_errors=True)
    say(f"placed Foxlatch in {app}")


def install(p: paths.Paths, python: str, build: str, dist: Path, agents: bool = False) -> int:
    try:
        own = builds.gecko_id(build)
        known = {builds.gecko_id(b) for b in builds.BUILDS}
    except ValueError as e:  # a bad personal-id
        say(f"install.sh: {e}")
        return 1
    try:
        migrated = migrate(p)
    except Refused as e:
        say(f"install.sh: {e}")
        return 1
    for line in migrated:
        say(f"migrated: {line}")
    for d in {p.state, p.run, p.approvals, p.config.parent}:
        private(d)
    if not p.config.exists():
        write(p.config, DEFAULT_CONFIG, 0o600)
        say(f"created {p.config} (hosts to refuse, to ask about, and to lock to one session)")
    write(p.launcher, launcher_text(python), 0o700)
    say(f"host launcher: {p.launcher} (runs {HOST} with {python})")
    p.native_manifest.parent.mkdir(parents=True, exist_ok=True)
    # Every Foxlatch build already registered stays so: profiles running the
    # other build keep their host. Ids that are not a Foxlatch build's are dropped.
    try:
        before = json.loads(p.native_manifest.read_text()).get("allowed_extensions") or []
    except (OSError, ValueError, AttributeError):
        before = []
    ids = [own] + sorted({i for i in before if isinstance(i, str) and i in known} - {own})
    manifest = {"name": paths.NAME, "description": "Foxlatch native host (local only)", "path": str(p.launcher),
                "type": "stdio", "allowed_extensions": ids}
    write(p.native_manifest, json.dumps(manifest, indent=2) + "\n", 0o644)
    say(f"native host registered for the {build} build ({own}): {p.native_manifest}"
        + (f"; still allowed: {', '.join(ids[1:])}" if ids[1:] else ""))
    version = json.loads((ROOT / "extension" / "manifest.json").read_text())["version"]
    package = dist / f"foxlatch-{version}{'' if build == 'public' else '-' + build}.zip"
    builds.write_zip(builds.package_files(ROOT / "extension", build), package)
    say(f"add-on package ({build} build): {package}",
        "  Firefox installs only signed add-ons: "
        + ("use the listed Foxlatch from addons.mozilla.org once it is published, or sign this package." if build == "public"
           else "run it unsigned in Firefox Developer Edition, Nightly or ESR, or load it as a temporary add-on (README: Personal build)."),
        "")
    if not agents:
        say(*mcp_setup(python))
        return 0
    done, ok = register_agents(python)
    say("Agents:", *(done or ["  no claude or codex CLI on PATH"]),
        f"  any other MCP client: command {shlex.quote(python)}, args [{shlex.quote(str(SERVER))}]")
    return 0 if ok else 1


# ---------- uninstall ----------

# What the host writes (host.py socket_key, write_approvals, move_aside), and
# all --purge removes: a state directory set to somewhere shared loses nothing else.
OWN_APPROVALS = re.compile(r"\.?[0-9a-f]{16}\.json(\.tmp|\.bad-[0-9TZ]+(-\d+)?)?")
OWN_RUN = re.compile(r"[0-9a-f]{16}\.(json|sock|lock|tmp)")


def uninstall(p: paths.Paths, purge: bool) -> int:
    if purge and host_running(p.run):
        # It holds its approvals in memory and writes them on the next
        # remember or forget, recreating what --purge removed.
        say("install.sh: Firefox is running a Foxlatch host; purged now, its approvals would come back. "
            "Quit Firefox, then run install.sh --uninstall --purge again.")
        return 1
    for f in (p.native_manifest, p.launcher):
        if f.exists() or f.is_symlink():
            f.unlink()
            say(f"removed {f}")
    if is_app(p.app) and not p.app.is_symlink():
        shutil.rmtree(p.app)
        say(f"removed {p.app}")
    say("an agent you added Foxlatch to keeps its entry: claude mcp remove --scope user foxlatch; codex mcp remove foxlatch")
    if not purge:
        say(f"kept {p.config} and {p.approvals} (--purge removes them too)")
        return 0
    if p.config.exists():
        p.config.unlink()
        say(f"removed {p.config}")
    for d, own in ((p.approvals, OWN_APPROVALS), (p.run, OWN_RUN)):
        if d.is_dir() and not d.is_symlink():
            for f in d.iterdir():
                if own.fullmatch(f.name) and (f.is_file() or f.is_socket()) and not f.is_symlink():
                    f.unlink()
            try:
                d.rmdir()  # only if nothing else is in it
                say(f"removed {d}")
            except OSError:
                say(f"removed Foxlatch's files from {d}; left the rest")
    for d in {p.state, p.config.parent}:
        try:
            d.rmdir()  # only if nothing else is in it
        except OSError:
            pass
    return 0


# ---------- doctor ----------

def python_ok(python: str) -> tuple[bool, str]:
    try:
        out = subprocess.run([python, "-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        version = tuple(int(x) for x in out.split("."))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False, f"{python} does not run"
    return version >= MIN_PYTHON, f"{python} is Python {out}" + ("" if version >= MIN_PYTHON else ", older than 3.11")


def doctor(p: paths.Paths, python: str) -> int:
    results: list[tuple[str, str]] = []  # (ok | warn | FAIL, what)

    def check(status: str, what: str) -> None:
        results.append((status, what))

    ok, what = python_ok(python)
    check("ok" if ok else "FAIL", f"Python: {what}")
    try:
        manifest = json.loads(p.native_manifest.read_text())
    except (OSError, ValueError) as e:
        manifest = None
        check("FAIL", f"native host: {p.native_manifest} is missing or unreadable ({e}); run install.sh")
    if isinstance(manifest, dict):
        target = Path(str(manifest.get("path", "")))
        if manifest.get("name") != paths.NAME:
            check("FAIL", f"native host: {p.native_manifest} names {manifest.get('name')!r}, not {paths.NAME!r}")
        if target.is_absolute() and target.is_file() and os.access(target, os.X_OK):
            check("ok", f"native host: {p.native_manifest} runs {target}")
            inner = launcher_target(target)
            if inner:
                good, said = python_ok(inner[0])
                check("ok" if good else "FAIL", f"launcher: {said}")
                found = Path(inner[1]).is_file()
                check("ok" if found else "FAIL", f"launcher: runs {inner[1]}" + ("" if found else
                      ", which is gone (the checkout moved?); run install.sh again from where it is now"))
            else:
                check("FAIL", f"launcher: {target} is not one install.sh wrote; run install.sh")
        else:
            check("FAIL", f"native host: {p.native_manifest} points at {target}, which is not an executable file; run install.sh")
        ids = {}
        for b in builds.BUILDS:
            try:
                ids[builds.gecko_id(b)] = b
            except ValueError as e:
                check("FAIL", f"{b} build: {e}")
        allowed = manifest.get("allowed_extensions")
        known = [ids[i] for i in allowed or [] if i in ids] if isinstance(allowed, list) else []
        check("ok" if known else "FAIL", f"allowed add-on: {allowed} ({', '.join(known) + ' build' if known else 'no Foxlatch build'})")
    for d in sorted({p.state, p.run, p.approvals, p.config.parent}):
        problem = paths.private_problem(d)
        check("FAIL" if problem else "ok", f"directory: {problem}" if problem else f"directory: {d} (0700)")
    sys.path.insert(0, str(ROOT / "host"))
    import host  # the host's own config validator, so doctor and the host never disagree
    lists, error = host.load_config(p.config)
    if error:
        check("FAIL", f"config: {p.config}: {error}; every session is refused until it is fixed")
    else:
        counts = ", ".join(f"{len(lists[k])} {k}" for k in host.CONFIG_KEYS)
        check("ok", f"config: {p.config} ({counts})" if p.config.exists() else f"config: {p.config} is missing (an empty config)")
    live = paths.live_hosts(p.run, PROTOCOL)
    if live:
        for info in live:
            check("ok", f"host: {info['profile']['name']} is open (pid {info['pid']}, {info.get('build', 'unknown')} build)")
    else:
        check("warn", "host: none running; open a Firefox profile that has the add-on installed")
    for status, what in results:
        say(f"{status:<4}  {what}")
    return 1 if any(s == "FAIL" for s, _ in results) else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="install.sh", description="Install, check or remove Foxlatch for this user.")
    ap.add_argument("--python", required=True, help=argparse.SUPPRESS)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--personal", action="store_true", help="install the personal build (with eval, define and call)")
    mode.add_argument("--uninstall", action="store_true", help="remove the native host and its launcher")
    mode.add_argument("--doctor", action="store_true", help="check this install")
    ap.add_argument("--purge", action="store_true", help="with --uninstall: remove config.json and approvals too")
    ap.add_argument("--place", action="store_true", help="copy this release into the app directory and install from there")
    ap.add_argument("--agents", action="store_true", help="add the MCP server to the claude and codex CLIs on PATH")
    args = ap.parse_args(argv)
    if args.purge and not args.uninstall:
        ap.error("--purge goes with --uninstall")
    if (args.place or args.agents) and (args.uninstall or args.doctor):
        ap.error("--place and --agents go with an install")
    try:
        p = paths.resolve(os.environ.get("FOXLATCH_PLATFORM") or sys.platform)
    except paths.Unsupported as e:
        print(f"install.sh: {e}", file=sys.stderr)
        return 1
    if args.doctor:
        return doctor(p, args.python)
    if args.uninstall:
        return uninstall(p, args.purge)
    if args.place and ROOT != p.app.resolve():
        try:
            place(p)
        except Refused as e:
            print(f"install.sh: {e}", file=sys.stderr)
            return 1
        rest = [a for a in (sys.argv[1:] if argv is None else argv) if a != "--place"]
        os.execv(args.python, [args.python, "-I", str(p.app / "foxlatch" / "install.py"), *rest])
    dist = Path(os.environ.get("FOXLATCH_DIST") or ROOT / "dist")
    return install(p, args.python, "personal" if args.personal else "public", dist, args.agents)


if __name__ == "__main__":
    sys.exit(main())
