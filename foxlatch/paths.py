"""Where Foxlatch keeps its files, per platform, for the host, the MCP server
and the installer alike (each imports this; none keeps its own copy).

macOS: ~/Library/Application Support/foxlatch holds config.json, approvals/
and run/; the native manifest is in ~/Library/Application Support/Mozilla/
NativeMessagingHosts. Linux: config.json in ${XDG_CONFIG_HOME:-~/.config}/
foxlatch, approvals/ and run/ in ${XDG_STATE_HOME:-~/.local/state}/foxlatch,
the native manifest in ~/.mozilla/native-messaging-hosts. The code itself,
when get.sh installed it, is in app/: next to the state on macOS, in
${XDG_DATA_HOME:-~/.local/share}/foxlatch on Linux.

FOXLATCH_STATE_DIR (tests) puts everything, config.json included, in one
directory.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

NAME = "foxlatch"  # the native messaging host name, and every directory's
LAUNCHER = "foxlatch-host"
# sockaddr_un.sun_path, terminating NUL included: a socket path must be shorter.
SUN_PATH_MAX = {"darwin": 104, "linux": 108}
SOCKET_FALLBACK_ROOT = Path("/tmp")


class Unsupported(Exception):
    """Foxlatch runs on macOS and Linux only."""


class NotPrivate(Exception):
    """A directory or socket that should be this user's alone is not."""


def system_of(platform: str = sys.platform) -> str:
    if platform == "darwin":
        return "darwin"
    if platform.startswith("linux"):
        return "linux"
    raise Unsupported(f"Foxlatch runs on macOS and Linux; this is {platform}")


@dataclass(frozen=True)
class Paths:
    system: str
    config: Path          # config.json
    state: Path           # holds approvals/, run/ and the host launcher
    run: Path
    approvals: Path
    launcher: Path
    native_manifest: Path
    firefox_roots: tuple[Path, ...]  # where profiles.ini may be
    app: Path             # the code, when get.sh placed it (install.sh --place)
    legacy_state: Path | None = None     # before the rename (macOS only)
    legacy_manifest: Path | None = None


def _xdg(env, name: str, default: Path) -> Path:
    """An XDG base directory: the variable if it holds an absolute path (the
    spec says to ignore a relative one), else the default."""
    value = env.get(name, "")
    return Path(value) if value.startswith("/") else default


def resolve(platform: str = sys.platform, env=None, home: Path | None = None) -> Paths:
    env = os.environ if env is None else env
    system = system_of(platform)
    home = Path(env.get("HOME") or Path.home()) if home is None else home
    if system == "darwin":
        support = home / "Library/Application Support"
        state = support / NAME
        config = state / "config.json"
        app = state / "app"
        manifest = support / "Mozilla/NativeMessagingHosts" / f"{NAME}.json"
        roots = (support / "Firefox",)
        legacy = (support / "firefox-driver", support / "Mozilla/NativeMessagingHosts/firefox_driver.json")
    else:
        state = _xdg(env, "XDG_STATE_HOME", home / ".local/state") / NAME
        config = _xdg(env, "XDG_CONFIG_HOME", home / ".config") / NAME / "config.json"
        app = _xdg(env, "XDG_DATA_HOME", home / ".local/share") / NAME / "app"
        manifest = home / ".mozilla/native-messaging-hosts" / f"{NAME}.json"
        # Firefox's classic profile root, and the XDG one newer releases use.
        roots = (home / ".mozilla/firefox", _xdg(env, "XDG_CONFIG_HOME", home / ".config") / "mozilla/firefox")
        legacy = (None, None)
    override = env.get("FOXLATCH_STATE_DIR")
    if override:
        state = Path(override)
        config = state / "config.json"
        app = state / "app"
    return Paths(system=system, config=config, state=state, run=state / "run", approvals=state / "approvals",
                 launcher=state / LAUNCHER, native_manifest=manifest, firefox_roots=roots, app=app,
                 legacy_state=legacy[0], legacy_manifest=legacy[1])


# ---------- sockets ----------

def fits(path: Path, system: str) -> bool:
    return len(os.fsencode(str(path))) < SUN_PATH_MAX[system]


def socket_path(run_dir: Path, key: str, system: str, fallback_root: Path = SOCKET_FALLBACK_ROOT) -> Path:
    """Where the host for profile `key` binds: in the private run directory
    when the path fits AF_UNIX's limit, else in a short private directory of
    this user's under fallback_root (/tmp/foxlatch-<uid>). Pure: listen()
    makes and checks the fallback directory (private_dir)."""
    inside = run_dir / f"{key}.sock"
    if fits(inside, system):
        return inside
    outside = fallback_root / f"{NAME}-{os.geteuid()}" / f"{key}.sock"
    if not fits(outside, system):
        raise NotPrivate(f"no socket path fits the {SUN_PATH_MAX[system] - 1}-byte limit: {inside} and {outside} are too long")
    return outside


def private_problem(path: Path) -> str | None:
    """Why `path` is not a directory only this user can open (a real
    directory, not a symlink, owned by this user, mode 0700), or None."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return f"{path} does not exist"
    except OSError as e:
        return f"{path} cannot be read ({e.strerror or e})"
    if stat.S_ISLNK(st.st_mode):
        return f"{path} is a symlink"
    if not stat.S_ISDIR(st.st_mode):
        return f"{path} is not a directory"
    if st.st_uid != os.geteuid():
        return f"{path} belongs to uid {st.st_uid}, not this user ({os.geteuid()})"
    if stat.S_IMODE(st.st_mode) != 0o700:
        return f"{path} has mode {stat.S_IMODE(st.st_mode):04o}, not 0700"
    return None


def private_dir(path: Path) -> None:
    """Makes `path` (mode 0700) if it is missing, then refuses it unless
    private_problem finds nothing wrong. An existing directory is never
    loosened or taken over: one someone else made, or left open, is refused."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    problem = private_problem(path)
    if problem:
        raise NotPrivate(f"refusing the socket directory: {problem}")


def socket_problem(path: Path) -> str | None:
    """Why the socket at `path` is not one this user's host made (a socket,
    owned by this user, in a directory only this user can open), or None."""
    try:
        st = os.lstat(path)
    except OSError as e:
        return f"{path} cannot be read ({e.strerror or e})"
    if not stat.S_ISSOCK(st.st_mode):
        return f"{path} is not a socket"
    if st.st_uid != os.geteuid():
        return f"{path} belongs to uid {st.st_uid}, not this user ({os.geteuid()})"
    return private_problem(path.parent)


# ---------- the registry ----------

def live_hosts(run_dir: Path, protocol: int) -> list[dict]:
    """Registry entries in run_dir whose host process is alive and speaks
    `protocol`, each with its key (the file's stem)."""
    found = []
    for f in sorted(run_dir.glob("*.json")):
        try:
            info = json.loads(f.read_text())
            os.kill(int(info["pid"]), 0)
        except (OSError, ValueError, KeyError, TypeError):
            continue  # unreadable, or the host is gone
        if isinstance(info, dict) and info.get("protocol") == protocol and isinstance(info.get("socket"), str) \
                and Path(info["socket"]).exists():
            info["key"] = f.stem
            found.append(info)
    return found
