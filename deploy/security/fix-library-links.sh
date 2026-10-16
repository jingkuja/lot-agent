#!/bin/sh
# Pin runtime library alternatives inside /usr, the sandbox's read-only tree.
# Debian BLAS/LAPACK links otherwise traverse /etc/alternatives (not mounted).
set -eu
find /usr/lib -type l -lname '/etc/alternatives/*' -exec sh -eu -c '
  for link do
    target=$(readlink -f "$link")
    case "$target" in
      /usr/lib/*) test -f "$target" ;;
      *) echo >&2 "Refusing alternative outside /usr/lib: $link"; exit 1 ;;
    esac
    ln -sfn "$target" "$link"
    printf "Pinned library: %s -> %s\n" "$link" "$target"
  done
' sh {} +
