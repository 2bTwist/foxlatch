"""install.sh and foxlatch/: paths per platform, install, the two builds'
packages, migration, uninstall and doctor, each run in a temporary HOME.

Run: python3 -m unittest discover -s tests
The Linux layout is installed here through FOXLATCH_PLATFORM=linux; that
Firefox on Linux finds and runs it is checked on a real Linux machine.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The suite never reads the developer's own Foxlatch config (personal-id
# included): everything this process resolves lives in a throwaway directory.
_OWN_STATE = tempfile.TemporaryDirectory()
os.environ["FOXLATCH_STATE_DIR"] = _OWN_STATE.name
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "host"))
sys.path.insert(0, str(ROOT / "mcp"))
import host  # noqa: E402
import server  # noqa: E402
from foxlatch import build as builds  # noqa: E402
from foxlatch import paths  # noqa: E402

mode = lambda p: stat.S_IMODE(os.lstat(p).st_mode)  # noqa: E731


class Paths(unittest.TestCase):
    def test_macos_keeps_everything_in_application_support(self):
        p = paths.resolve("darwin", {}, Path("/Users/u"))
        support = Path("/Users/u/Library/Application Support")
        self.assertEqual((p.config, p.run, p.approvals), (support / "foxlatch/config.json", support / "foxlatch/run", support / "foxlatch/approvals"))
        self.assertEqual(p.native_manifest, support / "Mozilla/NativeMessagingHosts/foxlatch.json")
        self.assertEqual((p.legacy_state, p.legacy_manifest), (support / "firefox-driver", support / "Mozilla/NativeMessagingHosts/firefox_driver.json"))

    def test_linux_follows_xdg_and_ignores_a_relative_value(self):
        home = Path("/home/u")
        p = paths.resolve("linux", {}, home)
        self.assertEqual((p.config, p.state), (home / ".config/foxlatch/config.json", home / ".local/state/foxlatch"))
        self.assertEqual(p.native_manifest, home / ".mozilla/native-messaging-hosts/foxlatch.json")
        self.assertIsNone(p.legacy_state)
        p = paths.resolve("linux", {"XDG_CONFIG_HOME": "/cfg", "XDG_STATE_HOME": "/st"}, home)
        self.assertEqual((p.config, p.run, p.approvals), (Path("/cfg/foxlatch/config.json"), Path("/st/foxlatch/run"), Path("/st/foxlatch/approvals")))
        p = paths.resolve("linux", {"XDG_CONFIG_HOME": "cfg", "XDG_STATE_HOME": "./st"}, home)
        self.assertEqual((p.config, p.state), (home / ".config/foxlatch/config.json", home / ".local/state/foxlatch"))

    def test_other_platforms_are_refused_by_name(self):
        with self.assertRaisesRegex(paths.Unsupported, "macOS and Linux; this is win32"):
            paths.resolve("win32", {}, Path("/x"))

    def test_socket_paths_keep_to_each_platforms_limit(self):
        run = Path("/r" + "x" * 82)  # its socket path is 106 bytes
        self.assertEqual(paths.socket_path(run, "k" * 16, "linux").parent, run)  # fits in 108
        self.assertEqual(paths.socket_path(run, "k" * 16, "darwin").parent, Path(f"/tmp/foxlatch-{os.geteuid()}"))  # not in 104
        with self.assertRaisesRegex(paths.NotPrivate, "too long"):
            paths.socket_path(run, "k" * 16, "darwin", Path("/" + "y" * 100))


class Install(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.dist = Path(self.tmp.name) / "dist"
        # A PATH with python3 (this interpreter) and what install.sh itself runs.
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        (self.bin / "python3").symlink_to(sys.executable)
        (self.bin / "dirname").symlink_to(shutil.which("dirname"))
        self.p = paths.resolve("darwin", {}, self.home) if sys.platform == "darwin" else paths.resolve("linux", {}, self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def run_install(self, *args, env=None, check=True):
        env = {"PATH": str(self.bin), "HOME": str(self.home), "FOXLATCH_DIST": str(self.dist), **(env or {})}
        out = subprocess.run(["/bin/sh", str(ROOT / "install.sh"), *args], env=env, capture_output=True, text=True)
        if check:
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        return out

    def unpack(self, package):
        with zipfile.ZipFile(package) as z:
            return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}

    def test_install_sh_is_executable_as_the_readme_runs_it(self):
        mode = subprocess.run(["git", "ls-files", "-s", "install.sh"], cwd=ROOT, capture_output=True, text=True).stdout.split()[:1]
        self.assertEqual(mode, ["100755"], "./install.sh fails with permission denied in a fresh clone")

    def test_install_registers_the_public_build_through_a_launcher_with_the_python_found(self):
        out = self.run_install().stdout
        manifest = json.loads(self.p.native_manifest.read_text())
        self.assertEqual(manifest, {"name": "foxlatch", "description": "Foxlatch native host (local only)",
                                    "path": str(self.p.launcher), "type": "stdio", "allowed_extensions": ["foxlatch@foxlatch"]})
        self.assertEqual(mode(self.p.launcher), 0o700)
        python = str(self.bin / "python3")
        self.assertIn(f"exec {python} -I {ROOT / 'host/host.py'} \"$@\"", self.p.launcher.read_text())
        for d in (self.p.state, self.p.run, self.p.approvals, self.p.config.parent):
            self.assertEqual(mode(d), 0o700, d)
        self.assertEqual(mode(self.p.config), 0o600)
        self.assertEqual(host.load_config(self.p.config), ({"deny": [], "protect": [], "exclusive": []}, None))
        self.assertIn(f"claude mcp add --scope user foxlatch -- {python} {ROOT / 'mcp/server.py'}", out)
        self.assertIn(f'[mcp_servers.foxlatch]\n    command = "{python}"\n    args = ["{ROOT / "mcp/server.py"}"]', out)
        self.assertNotIn("migrated", out)

    def test_the_launcher_starts_the_host_as_firefox_would(self):
        self.run_install()
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "FOXLATCH_PROFILE": "Profile 4\t/profiles/p4"}
        proc = subprocess.Popen([str(self.p.launcher), str(self.p.native_manifest), "foxlatch@foxlatch"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            head = proc.stdout.read(4)
            hello = json.loads(proc.stdout.read(int.from_bytes(head, sys.byteorder)))
        finally:
            proc.stdin.close()
            proc.wait(5)
            proc.stdout.close()
            proc.stderr.close()
        self.assertEqual((hello["type"], hello["profile"]["name"]), ("hello", "Profile 4"))

    # The add-on cannot list its own directory, so files.json names what it
    # hashes; a file the package holds but the list leaves out would change
    # unreported. The public package is the tree itself.
    def test_the_public_package_is_the_tree_and_files_json_lists_exactly_it(self):
        self.run_install()
        version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
        files = self.unpack(self.dist / f"foxlatch-{version}.zip")
        self.assertEqual(sorted(json.loads((ROOT / "extension/files.json").read_text())), sorted(files))
        self.assertEqual(files, {n: (ROOT / "extension" / n).read_bytes() for n in builds.shipped(ROOT / "extension")})
        self.assertEqual(builds.digest(files, json.loads(files["files.json"])), server.addon_digest(ROOT / "extension", "public"))

    def test_personal_adds_scripts_and_rewrites_id_name_and_background_in_the_package_only(self):
        tree = {n: (ROOT / "extension" / n).read_bytes() for n in builds.shipped(ROOT / "extension")}
        self.run_install("--personal")
        self.assertEqual(json.loads(self.p.native_manifest.read_text())["allowed_extensions"], ["foxlatch-personal@localhost"])
        version = json.loads(tree["manifest.json"])["version"]
        files = self.unpack(self.dist / f"foxlatch-{version}-personal.zip")
        m = json.loads(files["manifest.json"])
        self.assertEqual((m["browser_specific_settings"]["gecko"]["id"], m["name"]), ("foxlatch-personal@localhost", "Foxlatch (personal)"))
        self.assertEqual(m["background"]["scripts"], ["core.js", "page.js", "scripts.js", "background.js"])
        public_manifest = json.loads(tree["manifest.json"])
        m["browser_specific_settings"]["gecko"]["id"], m["name"] = "foxlatch@foxlatch", "Foxlatch"
        m["background"]["scripts"].remove("scripts.js")
        self.assertEqual(m, public_manifest, "the personal manifest differs in more than its id, name and scripts.js")
        self.assertEqual(files["scripts.js"], (ROOT / "extension-personal/scripts.js").read_bytes())
        self.assertEqual(sorted(json.loads(files["files.json"])), sorted(files))
        rewritten = ("manifest.json", "files.json", "scripts.js")
        self.assertEqual({n: b for n, b in files.items() if n not in rewritten}, {n: b for n, b in tree.items() if n not in rewritten})
        self.assertEqual({n: (ROOT / "extension" / n).read_bytes() for n in builds.shipped(ROOT / "extension")}, tree, "the tree changed")
        # What the personal add-on reports is what the server expects of that build, and not of the public one.
        reported = builds.digest(files, json.loads(files["files.json"]))
        self.assertEqual(reported, server.addon_digest(ROOT / "extension", "personal"))
        self.assertNotEqual(reported, server.addon_digest(ROOT / "extension", "public"))

    def test_the_personal_build_takes_the_signers_id_from_personal_id(self):
        self.p.config.parent.mkdir(parents=True, exist_ok=True)
        (self.p.config.parent / "personal-id").write_text("me@example.org\n")
        self.run_install("--personal")
        self.assertEqual(json.loads(self.p.native_manifest.read_text())["allowed_extensions"], ["me@example.org"])
        version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
        m = json.loads(self.unpack(self.dist / f"foxlatch-{version}-personal.zip")["manifest.json"])
        self.assertEqual(m["browser_specific_settings"]["gecko"]["id"], "me@example.org")
        (self.p.config.parent / "personal-id").write_text("not an id")
        out = self.run_install("--personal", check=False)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("must hold one add-on id", out.stdout + out.stderr)

    def test_a_bad_personal_id_stops_only_what_needs_it(self):
        # It was read as the build module loaded: the MCP server would not
        # start, and doctor and uninstall failed before they could help.
        self.run_install()
        (self.p.config.parent / "personal-id").write_text("not an id")
        env = {"PATH": str(self.bin), "HOME": str(self.home)}
        server = subprocess.run([sys.executable, str(ROOT / "mcp/server.py")], input="", env=env, capture_output=True, text=True)
        self.assertEqual(server.returncode, 0, server.stderr)
        doctor = self.run_install("--doctor", check=False)
        self.assertNotIn("Traceback", doctor.stdout + doctor.stderr)
        self.assertIn("must hold one add-on id", doctor.stdout + doctor.stderr)
        self.run_install("--uninstall")
        self.assertFalse(self.p.native_manifest.exists())

    def test_a_second_install_keeps_the_users_config(self):
        self.run_install()
        self.p.config.write_text('{"deny": ["claims.example.org"]}')
        out = self.run_install("--personal").stdout
        self.assertEqual(self.p.config.read_text(), '{"deny": ["claims.example.org"]}')
        self.assertNotIn("created", out)

    def test_linux_layout(self):
        env = {"FOXLATCH_PLATFORM": "linux", "XDG_CONFIG_HOME": str(self.home / "cfg"), "XDG_STATE_HOME": str(self.home / "st")}
        self.run_install(env=env)
        manifest = json.loads((self.home / ".mozilla/native-messaging-hosts/foxlatch.json").read_text())
        self.assertEqual(manifest["path"], str(self.home / "st/foxlatch/foxlatch-host"))
        self.assertEqual(host.load_config(self.home / "cfg/foxlatch/config.json")[1], None)
        for d in ("cfg/foxlatch", "st/foxlatch", "st/foxlatch/run", "st/foxlatch/approvals"):
            self.assertEqual(mode(self.home / d), 0o700, d)
        self.assertFalse((self.home / "Library").exists())
        self.assertEqual(self.run_install("--doctor", env=env, check=False).returncode, 0)

    def test_no_python_311_is_a_clear_error(self):
        shutil.rmtree(self.bin)
        self.bin.mkdir()
        (self.bin / "dirname").symlink_to(shutil.which("dirname"))
        old = self.bin / "python3"
        old.write_text("#!/bin/sh\nexit 1\n")  # what a Python older than 3.11 answers to the version check
        old.chmod(0o755)
        out = self.run_install(check=False)
        self.assertEqual(out.returncode, 1)
        self.assertIn("needs Python 3.11 or later", out.stderr)
        self.assertFalse(self.p.native_manifest.exists())

    @unittest.skipUnless(sys.platform == "darwin", "the old directory existed only on macOS")
    def test_migration_waits_while_a_host_from_before_the_rename_runs(self):
        # That host keeps writing the old approvals/ (a Forget included); moved
        # now, a forgotten approval would come back at the next start.
        old = self.home / "Library/Application Support/firefox-driver"
        (old / "approvals").mkdir(parents=True)
        (old / "approvals" / "abc.json").write_text('{"version": 1, "approvals": []}')
        (old / "run").mkdir()
        (old / "run" / "abc.json").write_text(json.dumps({"pid": os.getpid()}))
        out = self.run_install(check=False)
        self.assertEqual(out.returncode, 1, out.stdout)
        self.assertIn("Quit Firefox", out.stdout + out.stderr)
        self.assertTrue((old / "approvals" / "abc.json").exists())
        self.assertFalse(self.p.approvals.exists() and any(self.p.approvals.iterdir()))

    def test_purge_waits_while_a_host_runs(self):
        # A running host holds its approvals in memory and writes them back
        # on the next remember: purged now, they would return.
        self.run_install()
        (self.p.approvals / "0123456789abcdef.json").write_text("{}")
        (self.p.run / "0123456789abcdef.json").write_text(json.dumps({"pid": os.getpid()}))
        out = self.run_install("--uninstall", "--purge", check=False)
        self.assertEqual(out.returncode, 1, out.stdout)
        self.assertIn("Quit Firefox", out.stdout + out.stderr)
        self.assertTrue((self.p.approvals / "0123456789abcdef.json").exists())
        self.assertTrue(self.p.native_manifest.exists(), "refused, so nothing is removed")

    def test_installing_one_build_keeps_the_other_registered(self):
        self.run_install("--personal")
        self.run_install()
        allowed = json.loads(self.p.native_manifest.read_text())["allowed_extensions"]
        self.assertEqual(sorted(allowed), sorted(["foxlatch@foxlatch", "foxlatch-personal@localhost"]))
        # An id that is not a Foxlatch build's is never carried over.
        m = json.loads(self.p.native_manifest.read_text())
        m["allowed_extensions"].append("stranger@example.com")
        self.p.native_manifest.write_text(json.dumps(m))
        self.run_install()
        self.assertNotIn("stranger@example.com", json.loads(self.p.native_manifest.read_text())["allowed_extensions"])

    def test_purge_removes_only_the_files_foxlatch_writes(self):
        # FOXLATCH_STATE_DIR pointed at a directory that is not Foxlatch's own.
        (self.home / "run").mkdir()
        (self.home / "run" / "notes.txt").write_text("the user's")
        (self.home / "approvals").mkdir()
        (self.home / "approvals" / "signed.pdf").write_text("the user's")
        env = {"FOXLATCH_STATE_DIR": str(self.home)}
        self.run_install(env=env)
        (self.home / "approvals" / "0123456789abcdef.json").write_text("{}")
        (self.home / "approvals" / "0123456789abcdef.json.bad-20261107T000000Z").write_text("{}")
        self.run_install("--uninstall", "--purge", env=env)
        self.assertTrue((self.home / "run" / "notes.txt").exists())
        self.assertTrue((self.home / "approvals" / "signed.pdf").exists())
        self.assertEqual(sorted(x.name for x in (self.home / "approvals").iterdir()), ["signed.pdf"])

    def test_doctor_fails_when_the_launcher_runs_a_host_that_is_gone(self):
        self.run_install()
        # The checkout moved after install: Firefox cannot start the host.
        text = self.p.launcher.read_text().replace(str(ROOT / "host" / "host.py"), "/nonexistent/foxlatch/host/host.py")
        self.p.launcher.write_text(text)
        out = self.run_install("--doctor", check=False)
        self.assertEqual(out.returncode, 1, out.stdout)
        self.assertIn("/nonexistent/foxlatch/host/host.py", out.stdout)

    @unittest.skipUnless(sys.platform == "darwin", "the migration is from the macOS layout")
    def test_macos_migrates_config_and_approvals_and_removes_the_old_registration(self):
        old = self.home / "Library/Application Support/firefox-driver"
        (old / "approvals").mkdir(parents=True)
        (old / "config.json").write_text('{"exclusive": ["benefits.example.gov"]}')
        (old / "approvals" / "abc.json").write_text('{"version": 1, "approvals": []}')
        old_manifest = self.p.native_manifest.with_name("firefox_driver.json")
        old_manifest.parent.mkdir(parents=True)
        old_manifest.write_text("{}")
        other = old_manifest.with_name("someone_else.json")
        other.write_text("{}")
        out = self.run_install("--personal").stdout
        self.assertEqual(self.p.config.read_text(), '{"exclusive": ["benefits.example.gov"]}')
        self.assertEqual((self.p.approvals / "abc.json").read_text(), '{"version": 1, "approvals": []}')
        self.assertFalse(old_manifest.exists())
        self.assertTrue(other.exists())
        for said in ("migrated: moved", "config.json", "approvals", "removed the old native host registration"):
            self.assertIn(said, out)
        # Once this install has its own, an old one is left where it is.
        self.p.config.write_text('{"deny": []}')
        (old / "config.json").write_text('{"deny": ["x.test"]}')
        self.run_install()
        self.assertEqual(self.p.config.read_text(), '{"deny": []}')
        self.assertTrue((old / "config.json").exists())

    def test_uninstall_keeps_config_and_approvals_and_purge_removes_only_foxlatchs(self):
        self.run_install()
        (self.p.approvals / "0123456789abcdef.json").write_text("{}")
        other = self.p.native_manifest.with_name("someone_else.json")
        other.write_text("{}")
        out = self.run_install("--uninstall").stdout
        self.assertFalse(self.p.native_manifest.exists())
        self.assertFalse(self.p.launcher.exists())
        self.assertTrue(self.p.config.exists() and (self.p.approvals / "0123456789abcdef.json").exists())
        self.assertIn("--purge removes them too", out)
        self.run_install("--uninstall", "--purge")
        self.assertFalse(self.p.state.exists())
        self.assertFalse(self.p.config.exists())
        self.assertTrue(other.exists())

    def test_doctor_reports_each_check_and_fails_on_what_breaks_control(self):
        self.run_install()
        out = self.run_install("--doctor", check=False)
        self.assertEqual(out.returncode, 0, out.stdout)
        for said in ("ok    Python:", "ok    native host:", "ok    launcher:", "allowed add-on: ['foxlatch@foxlatch'] (public build)",
                     "ok    config:", "warn  host: none running"):
            self.assertIn(said, out.stdout)
        # A live host in run/ is listed with its build.
        sock = self.p.run / "k.sock"
        sock.write_text("")
        (self.p.run / "k.json").write_text(json.dumps({"protocol": 2, "profile": {"name": "Profile 4"}, "socket": str(sock),
                                                       "pid": os.getpid(), "started": int(time.time()), "build": "public"}))
        self.assertIn("ok    host: Profile 4 is open", self.run_install("--doctor", check=False).stdout)
        # What refuses control, or keeps Firefox from starting the host, fails.
        self.p.config.write_text('{"deny": ["https://claims.example.org"]}')
        os.chmod(self.p.approvals, 0o755)
        self.p.launcher.unlink()
        out = self.run_install("--doctor", check=False)
        self.assertEqual(out.returncode, 1)
        self.assertIn("has a scheme", out.stdout)
        self.assertIn("has mode 0755, not 0700", out.stdout)
        self.assertIn("which is not an executable file", out.stdout)

    @unittest.skipUnless(shutil.which("shellcheck"), "shellcheck is not on PATH")
    def test_install_sh_is_shellcheck_clean(self):
        out = subprocess.run(["shellcheck", "--shell=sh", str(ROOT / "install.sh")], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout)


class OneLineInstall(unittest.TestCase):
    """get.sh, as `curl -fsSL .../get.sh | sh` runs it: it downloads a release
    tarball, install.sh --place copies it into the per-user app directory and
    installs from there, and --agents registers the MCP server with the agent
    CLIs on PATH through their own `mcp add`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        t = Path(self.tmp.name)
        self.home, self.bin, self.log = t / "home", t / "bin", t / "agents.log"
        self.home.mkdir()
        self.bin.mkdir()
        (self.bin / "python3").symlink_to(sys.executable)
        for tool in ("dirname", "curl", "tar", "mktemp", "rm", "mkdir", "gzip"):
            (self.bin / tool).symlink_to(shutil.which(tool))
        for cli in ("claude", "codex"):  # record each call; `mcp remove` of a missing server fails as theirs do
            script = self.bin / cli
            script.write_text(f'#!/bin/sh\necho "{cli} $*" >> {self.log}\n[ "$2" != remove ]\n')
            script.chmod(0o755)
        self.tarball = t / "foxlatch-test.tar.gz"
        skip = {".git", "dist", ".claude", "__pycache__", "node_modules"}
        import tarfile
        with tarfile.open(self.tarball, "w:gz") as tar:
            for f in sorted(ROOT.rglob("*")):
                rel = f.relative_to(ROOT)
                if f.is_file() and not skip & set(rel.parts):
                    tar.add(f, arcname=f"foxlatch-test/{rel}")
        self.p = paths.resolve(sys.platform, {}, self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def get(self, *args, check=True):
        env = {"PATH": str(self.bin), "HOME": str(self.home), "FOXLATCH_URL": self.tarball.as_uri(), "TMPDIR": self.tmp.name}
        with open(ROOT / "get.sh") as script:  # piped, as curl | sh runs it
            out = subprocess.run(["/bin/sh", "-s", "--", *args], stdin=script, env=env, capture_output=True, text=True)
        if check:
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        return out

    def test_the_app_directory_is_per_user_data(self):
        self.assertEqual(paths.resolve("darwin", {}, Path("/Users/u")).app, Path("/Users/u/Library/Application Support/foxlatch/app"))
        self.assertEqual(paths.resolve("linux", {}, Path("/home/u")).app, Path("/home/u/.local/share/foxlatch/app"))
        self.assertEqual(paths.resolve("linux", {"XDG_DATA_HOME": "/d"}, Path("/home/u")).app, Path("/d/foxlatch/app"))

    def test_get_sh_installs_from_the_app_directory_and_registers_both_agents(self):
        self.get()
        app = self.p.app.resolve()  # /tmp is /private/tmp on macOS
        self.assertTrue((app / "host/host.py").is_file() and (app / "mcp/server.py").is_file())
        self.assertIn(shlex_quote(str(app / "host/host.py")), self.p.launcher.read_text())
        server_py = str(app / "mcp/server.py")
        calls = self.log.read_text().splitlines()
        self.assertIn(f"claude mcp add --scope user foxlatch -- {self.bin / 'python3'} {server_py}", calls)
        self.assertIn(f"codex mcp add foxlatch -- {self.bin / 'python3'} {server_py}", calls)
        self.assertEqual([f for f in Path(self.tmp.name).iterdir() if f.name.startswith("foxlatch.")], [])  # its temp dir is gone

    def test_running_it_again_replaces_the_app_and_each_registration(self):
        self.get()
        (self.p.app / "stale.txt").write_text("from the last version")
        self.get()
        self.assertFalse((self.p.app / "stale.txt").exists())
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls.count("claude mcp remove --scope user foxlatch"), 2)
        self.assertEqual([c.split()[0] + " " + c.split()[2] for c in calls if " add " in f" {c} "].count("claude add"), 2)

    def test_an_agent_that_refuses_the_server_fails_the_install_and_says_how_to_add_it(self):
        (self.bin / "codex").write_text(f'#!/bin/sh\necho "codex $*" >> {self.log}\n[ "$2" != add ] || {{ echo "config is read-only" >&2; exit 1; }}\n')
        out = self.get(check=False)
        self.assertNotEqual(out.returncode, 0, out.stdout + out.stderr)
        text = out.stdout + out.stderr
        self.assertIn("codex: could not add foxlatch (config is read-only)", text)
        self.assertIn(f"codex mcp add foxlatch -- {self.bin / 'python3'} ", text)
        self.assertIn("claude: added foxlatch", text)

    def test_a_place_cut_off_between_its_two_moves_loses_nothing_on_the_next_run(self):
        from foxlatch import install
        self.get()
        old = self.p.app.with_name(".app.old")
        os.replace(self.p.app, old)  # the last run stopped here: the app moved aside, the new one not yet in
        real = shutil.copytree

        def broken(*a, **k):
            raise OSError("disk full")
        shutil.copytree = broken
        try:
            with self.assertRaises(OSError):
                install.place(self.p)
        finally:
            shutil.copytree = real
        self.assertTrue(install.is_app(self.p.app), "the only whole copy was deleted")

    def test_place_refuses_an_app_directory_that_is_not_foxlatchs(self):
        self.p.app.mkdir(parents=True)
        (self.p.app / "notes.txt").write_text("mine")
        out = self.get(check=False)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("not a Foxlatch install", out.stdout + out.stderr)
        self.assertEqual((self.p.app / "notes.txt").read_text(), "mine")

    def test_uninstall_removes_the_app_directory(self):
        self.get()
        app_install = self.p.app / "install.sh"
        out = subprocess.run(["/bin/sh", str(app_install), "--uninstall"], env={"PATH": str(self.bin), "HOME": str(self.home)},
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertFalse(self.p.app.exists())

    def test_get_sh_the_server_and_the_add_on_name_one_release(self):
        version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
        self.assertEqual(server.SERVER_INFO["version"], version)
        self.assertIn(f"/archive/refs/tags/v{version}.tar.gz}}", (ROOT / "get.sh").read_text())

    def test_get_sh_is_shellcheck_clean(self):
        out = subprocess.run(["shellcheck", "--shell=sh", str(ROOT / "get.sh")], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout)


def shlex_quote(s: str) -> str:
    import shlex
    return shlex.quote(s)


class ScriptsArePersonalOnly(unittest.TestCase):
    """Mozilla's add-on policy forbids running remote code (2026-11-07): the
    public package must hold no code that can run a session's JavaScript, not
    code that a data file one byte from true switches off. That code is
    extension-personal/scripts.js, which only the personal package holds."""

    SCRIPTS = ROOT / "extension-personal" / "scripts.js"
    # The ways to run a string as code in a page: Firefox's door into the
    # page's own world (no rename possible), and the page functions of the
    # script path, each required to exist in scripts.js below, so a rename
    # fails here instead of leaving a marker that matches nothing.
    FIXED = ("wrappedJSObject", "evalInPage", "markDocument", "canEval")
    CODE = (r"\beval\s*\(", r"\bnew\s+Function\s*\(", r"\bFunction\s*\(")

    def markers(self) -> set[str]:
        text = self.SCRIPTS.read_text()
        for name in self.FIXED:
            self.assertRegex(text, rf"\b{name}\b", f"scripts.js no longer names {name}; update this test's markers")
        # Every function scripts.js declares, read from it: one copied back into the public package is found.
        declared = set(re.findall(r"^(?:async )?function (\w+)", text, re.M))
        self.assertTrue(declared, "scripts.js declares no functions; the test reads the wrong file")
        return {*self.FIXED, *declared}

    def test_the_public_package_holds_no_script_path(self):
        files = builds.package_files(ROOT / "extension", "public")
        self.assertNotIn("scripts.js", files)
        self.assertFalse((ROOT / "extension" / "scripts.js").exists(), "the tree, loaded as a temporary add-on, is the public build")
        self.assertEqual(json.loads(files["manifest.json"])["background"]["scripts"], ["core.js", "page.js", "background.js"])
        self.assertEqual(sorted(json.loads(files["files.json"])), sorted(files))
        found = []
        for name, data in files.items():
            text = data.decode("utf-8", "replace")
            found += [f"{name}: {m}" for m in sorted(self.markers()) if re.search(rf"\b{m}\b", text)]
            found += [f"{name}: {p}" for p in self.CODE if re.search(p, text)]
        self.assertEqual(found, [], "the public package holds code of the script path")

    def test_the_personal_package_adds_scripts_js_and_loads_it_before_background_js(self):
        public = builds.package_files(ROOT / "extension", "public")
        personal = builds.package_files(ROOT / "extension", "personal")
        self.assertEqual(personal["scripts.js"], self.SCRIPTS.read_bytes())
        self.assertEqual(set(personal), set(public) | {"scripts.js"})
        self.assertEqual(sorted(json.loads(personal["files.json"])), sorted(personal))
        self.assertEqual(json.loads(personal["manifest.json"])["background"]["scripts"], ["core.js", "page.js", "scripts.js", "background.js"])
        text = personal["scripts.js"].decode()
        self.assertTrue(all(re.search(rf"\b{m}\b", text) for m in self.markers()))


if __name__ == "__main__":
    unittest.main()
