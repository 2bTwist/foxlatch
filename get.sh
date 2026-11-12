#!/bin/sh
# Foxlatch one-line install for macOS and Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/2bTwist/foxlatch/main/get.sh | sh
#
# Downloads a Foxlatch release, copies it into your per-user app directory,
# registers the native host and adds Foxlatch to the claude and codex CLIs it
# finds (install.sh --place --agents). Run it again to update. Arguments after
# `sh -s --` go to install.sh (--personal for the personal build).
#
# FOXLATCH_URL installs another release tarball (tests use a file:// one).
set -eu

# Everything is in a function called on the last line, so a download cut off
# midway runs nothing.
main() {
  url=${FOXLATCH_URL:-https://github.com/2bTwist/foxlatch/archive/refs/tags/v1.0.4.tar.gz}
  for tool in curl tar mktemp; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "foxlatch: this installer needs $tool on PATH." >&2
      exit 1
    fi
  done
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/foxlatch.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM
  echo "foxlatch: downloading $url"
  curl -fsSL "$url" -o "$tmp/foxlatch.tar.gz"
  mkdir "$tmp/src"
  tar -xzf "$tmp/foxlatch.tar.gz" -C "$tmp/src" --strip-components 1
  status=0
  /bin/sh "$tmp/src/install.sh" --place --agents "$@" || status=$?
  exit "$status"
}

main "$@"
