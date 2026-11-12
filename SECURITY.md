# Security

Foxlatch holds a trust boundary over every site your Firefox profiles are
signed in to, so reports about it are welcome.

## Reporting

Report privately through the repository's GitHub security advisories
(Security tab, "Report a vulnerability"). Please do not open a public issue
for a vulnerability. Include the version (`extension/manifest.json`), the
build (public or personal), your platform, and the steps that reproduce it.

## In scope

The boundary the add-on, host and MCP server enforce:

- Pairing: a session drives a profile only after you click Allow on the
  add-on's own page with that session's code; allowing one session never
  ends another's control.
- Ownership: a session sees and acts on only the tabs it opened, in its own
  window.
- Refused sites (`deny`, non-web schemes, password fields) never reach a page
  script; protected sites ask you once per session (or per remembered
  approval you allowed at pairing); site locks hold a sign-in to one session
  at a time.
- Questions to you (pairing, protected sites, and in the personal build each
  script and function) are answered only from the add-on's own pages, and
  read only by the session that asked.
- The socket and native host: a session's id is bound to its connection,
  the socket lives in a directory only you can open, and the server connects
  only to a socket of yours.
- The public build runs no agent-supplied code (`eval`, `define`, `call`).

## Known limits (not vulnerabilities)

- Same-user processes. Any process running as you can write the remembered
  approvals file, connect to the socket, or change this code. A forged
  approval stands for no session until a pairing page lists it and you
  allow; a process that connects still needs your Allow with its code.
- Stop round-trip. Stop refuses every later call at once, but cannot undo
  page work already started, and an action cleared to run within one
  message round-trip of Stop may still run.
- What a session reads (page text, screenshots, addresses) goes to your
  agent and its model provider, by design.
