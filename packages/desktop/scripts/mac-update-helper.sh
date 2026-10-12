#!/bin/bash
# Runs independently of Electron. Arguments are paths prepared by the main
# process, never shell fragments. No sudo, quarantine removal or Gatekeeper bypass.
set -u
umask 077
pid="$1"
target="$2"
stage="$3"
backup="$4"
operation="$5"

status() { printf '%s\n' "$1" > "$operation/result.tmp"; /bin/mv -f "$operation/result.tmp" "$operation/result"; }
status waiting
printf 'ready\n' > "$operation/helper-ready"
for ((i=0; i<60; i++)); do
  /bin/kill -0 "$pid" 2>/dev/null || break
  /bin/sleep 1
done
if /bin/kill -0 "$pid" 2>/dev/null; then status failed; exit 1; fi

# Each rename is on the same volume. Never delete the only known good app.
if ! /bin/mv "$target" "$backup"; then status failed; /usr/bin/open "$target"; exit 1; fi
if ! /bin/mv "$stage" "$target"; then
  /bin/mv "$backup" "$target"
  status failed
  /usr/bin/open "$target"
  exit 1
fi
status launching
/usr/bin/open -n -W "$target" &
launcher_pid=$!
for ((i=0; i<120; i++)); do
  if [ -f "$operation/ack" ]; then status success; exit 0; fi
  /bin/sleep 1
done

# Do not overwrite a live but slow/unresponsive new app. Its first startup
# writes its PID before creating windows, allowing a graceful termination.
if [ -f "$operation/new-pid" ]; then
  new_pid="$(/bin/cat "$operation/new-pid")"
  case "$new_pid" in ''|*[!0-9]*) status recovery-required; exit 1 ;; esac
  /bin/kill -TERM "$new_pid" 2>/dev/null || true
  for ((i=0; i<15; i++)); do
    /bin/kill -0 "$new_pid" 2>/dev/null || break
    /bin/sleep 1
  done
  if /bin/kill -0 "$new_pid" 2>/dev/null; then status recovery-required; exit 1; fi
elif /bin/kill -0 "$launcher_pid" 2>/dev/null; then
  # The app may be alive before updater initialization. Never rename beneath it.
  status recovery-required
  exit 1
fi
# Keep the failed version for diagnosis, and retain the backup if any move fails.
if /bin/mv "$target" "$operation/failed.app" && /bin/mv "$backup" "$target"; then
  status failed
  /usr/bin/open "$target"
else
  status recovery-required
fi
