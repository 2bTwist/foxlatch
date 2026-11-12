# Foxlatch

Let your coding agent drive your own Firefox, with your say-so.

Any MCP agent session (Claude Code, Codex, others) can drive a Firefox profile
you choose, in your everyday Firefox, without WebDriver or Marionette, so
sites see a normal browser. Nothing happens until you allow the session in
that profile.

```
agent session ─stdio MCP─ mcp/server.py ─┐
agent session ─stdio MCP─ mcp/server.py ─┼─ Unix socket per profile (0600, in a 0700 dir)
                                         └─ host/host.py ─native messaging─ add-on in that profile
```

## Install (macOS and Linux)

Needs Python 3.11 or later and Firefox 140 or later. No packages to install.

```bash
curl -fsSL https://raw.githubusercontent.com/2bTwist/foxlatch/main/get.sh | sh
```

This downloads a release into your per-user app directory, registers the
native host, and adds Foxlatch to Claude Code and Codex if their CLIs are on
PATH (`claude mcp add` and `codex mcp add`). Run it again to update. From a
clone, `./install.sh` does the same without the download, from where the clone
is, and prints the agent commands instead of running them (`--agents` runs
them).

Either way it writes a launcher that runs the host with the Python it found,
creates the config and state directories (0700), and packages the add-on into
`dist/`.

| | macOS | Linux |
|---|---|---|
| config.json | `~/Library/Application Support/foxlatch/` | `${XDG_CONFIG_HOME:-~/.config}/foxlatch/` |
| approvals/, run/, launcher | `~/Library/Application Support/foxlatch/` | `${XDG_STATE_HOME:-~/.local/state}/foxlatch/` |
| app/ (get.sh installs) | `~/Library/Application Support/foxlatch/` | `${XDG_DATA_HOME:-~/.local/share}/foxlatch/` |
| native host | `~/Library/Application Support/Mozilla/NativeMessagingHosts/foxlatch.json` | `~/.mozilla/native-messaging-hosts/foxlatch.json` |

Then install the add-on in each profile you want drivable. Firefox installs
only signed add-ons: use Foxlatch from addons.mozilla.org once it is listed,
or sign `dist/foxlatch-<version>.zip` yourself. At install, Firefox asks you
to consent to website content and browsing activity being sent: they go to
the native host on this computer, which passes what a session reads to your
agent. A profile without the add-on is invisible to agents.

**Personal build.** `./install.sh --personal` packages a build that adds
`eval`, `define` and `call` (scripts you read and allow in Firefox). Mozilla's
add-on policy forbids running code an add-on did not ship, listed or not, so
this build is not for addons.mozilla.org: run it unsigned in Firefox Developer
Edition, Nightly or ESR with `xpinstall.signatures.required` set to `false` in
`about:config`, or load it as a temporary add-on (see Development), which
lasts until Firefox restarts. Its add-on id is `foxlatch-personal@localhost`
unless `personal-id` beside `config.json` names another (one line, such as
`foxlatch-personal@yourdomain`). The public build has no script code at all.

## Connect an agent

`install.sh` prints both, with your paths filled in:

```bash
claude mcp add --scope user foxlatch -- /path/to/python3 /path/to/foxlatch/mcp/server.py
```

```toml
# ~/.codex/config.toml
[mcp_servers.foxlatch]
command = "/path/to/python3"
args = ["/path/to/foxlatch/mcp/server.py"]
```

Each session starts its own server. Ask your agent to use Firefox; it lists
the profiles and asks you which one.

What an agent gets, mostly without screenshots or scripts:

| Need | Tool |
| --- | --- |
| Find a control | `find` by role, accessible name or text; returns refs |
| See what is on screen | `snapshot`: interactive elements, headings, dialogs, link targets |
| Read a table, form or list | `read`: rows with labelled columns, fields with values and options, items; paged |
| Read long text | `text`, paged by `offset` |
| Act | `click`, `type`, `select`, `key`, `hover`, `scroll`, each with an optional `waitFor` |
| Wait | `wait_for` text, a selector, a URL or a load, across navigations |
| Look | `screenshot` of the tab or one element |

## How consent works

- **Pairing.** The agent calls `connect`; a confirmation tab opens in that
  profile's window with a six-digit code, and the agent shows you the same
  code. Allow only if they match. The page lists what the session will be
  held to and says that what it reads goes to your agent and its model
  provider. Each session is allowed separately; one never ends another.
- **Its own window and tabs.** A session acts only on tabs it opened. It
  cannot type into password fields or open non-web pages.
- **Protected sites ask first.** The sign-in, account and mail pages of
  Google, Microsoft and Apple (iCloud included), and any `protect` host you
  add, ask you in Firefox the first time a session opens one. Tick Remember
  to allow it for later sessions from the same project (the full path of
  its repository); the pairing page lists every remembered approval before
  you allow, and the toolbar popup has Forget.
- **Refused sites never open.** `deny` hosts in `config.json`. Every load in
  a session's tab is checked before Firefox sends it, so a link, form or
  redirect cannot reach a refused site, a sign-in another session holds, or a
  protected site the session was not allowed on.
- **One session per sign-in.** Protected sites and `exclusive` hosts take one
  session at a time; others are refused with the holder's name.
- **Scripts (personal build).** Every `eval` shows you the exact code; a
  `define` is approved once per origin for the session.
- **Stop.** The toolbar popup lists driving sessions, each with Stop. Control
  also ends when the session exits or Firefox restarts, and is never
  restored without a new Allow. Its tabs are yours from then on: a session
  you allow again starts with none of them.

## Config

```json
{ "deny": ["claims.example.org"], "protect": ["portal.example.com"],
  "exclusive": ["benefits.example.gov", ["portal.example.org", "login.example-idp.com"]] }
```

Host names only (subdomains included). Config adds to the built-in lists,
never removes from them. A broken file refuses every session until it is
fixed, and the popup says why. Restart Firefox after editing.

## Check, update, uninstall

```bash
./install.sh --doctor             # Python, native host, launcher, add-on id, directories, config, open profiles
./install.sh --uninstall          # remove the native host and launcher; keeps config and approvals
./install.sh --uninstall --purge  # also remove config.json, approvals and run/
```

Run `./install.sh` again after moving the repository or changing Python. A
tool result warns when the server or the add-on runs other code than this
repository; restart the server or update the add-on, then connect again.

## Limits

- Clicks and keys are synthetic DOM events; a control that requires trusted
  input needs you. Human checks (CAPTCHA, Cloudflare) are yours.
- A page showing `alert()` blocks the session until you dismiss it.
- Stop cannot undo page work already started (a submitted form), and an
  action cleared within one message round-trip of Stop may still run.
- Any process running as you can forge a remembered approval; the pairing
  page, which lists them, is the defence. See [SECURITY.md](SECURITY.md).
- Windows is not supported yet. On Linux, Snap and Flatpak builds of Firefox
  start native hosts through a portal, which Foxlatch has not been tested
  with; use Firefox from mozilla.org or your distribution's package.
- Install one build per profile: with both, one serves and the other's
  toolbar button says why.

## Development

Load `extension/manifest.json` from `about:debugging` → This Firefox → Load
Temporary Add-on (unsigned until Firefox restarts; the tree is the public
build, with no script code at all). For the personal build, run
`./install.sh --personal` and load `dist/foxlatch-<version>-personal.zip` the
same way; its code for `eval`, `define` and `call` is
`extension-personal/scripts.js`, which only that package holds. Before
signing a changed public build, bump `version` in `extension/manifest.json`. A new
file in `extension/` goes into `extension/files.json` too; a test checks it
against the package.

```bash
node --test tests/core.test.js tests/page.test.js tests/addon.test.js && python3 -m unittest discover -s tests
```

MIT licensed; see [LICENSE](LICENSE).
