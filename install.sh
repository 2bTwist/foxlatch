#!/bin/sh
# Foxlatch installer for macOS and Linux. Finds Python 3.11 or later, then
# hands over to foxlatch/install.py with it.
#
#   ./install.sh                       register the host, package the public build
#   ./install.sh --personal            the same with the personal build (eval, define, call)
#   ./install.sh --place               copy this release into the per-user app directory first
#   ./install.sh --agents              also add Foxlatch to the claude and codex CLIs on PATH
#   ./install.sh --uninstall [--purge] remove the host registration (--purge: config and approvals too)
#   ./install.sh --doctor              check this install
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd -P)

# The first of these on PATH that is Python 3.11 or later, as an absolute path.
find_python() {
  for name in python3 python3.14 python3.13 python3.12 python3.11; do
    candidate=$(command -v "$name" 2>/dev/null) || continue
    case $candidate in
      /*) ;;
      *) continue ;;
    esac
    if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! PYTHON=$(find_python); then
  echo "install.sh: Foxlatch needs Python 3.11 or later on PATH (as python3), and none was found." >&2
  echo "  macOS: brew install python, or the installer from python.org" >&2
  echo "  Linux: your distribution's python3 package (3.11 or later)" >&2
  exit 1
fi
exec "$PYTHON" -I "$ROOT/foxlatch/install.py" --python "$PYTHON" "$@"
