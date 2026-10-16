#!/usr/bin/env bash
# Run against a pre-loaded AppArmor profile. No business volumes or credentials.
set -euo pipefail
policy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
seccomp_file="${1:-$policy_dir/media-analysis-seccomp.json}"
image_name="${2:-lot-agent-media-analysis:1.0}"
test -f "$seccomp_file"
seccomp_file="$(cd -- "$(dirname -- "$seccomp_file")" && pwd)/$(basename -- "$seccomp_file")"
case "$(docker image inspect "$image_name" --format '{{.Architecture}}')" in
  amd64|arm64) ;;
  *) echo >&2 'This media policy supports amd64 and arm64 only.'; exit 1 ;;
esac
docker run --rm -i --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --memory 512m --cpus 1 --pids-limit 128 \
  --user node --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt apparmor=lot-agent-media-analysis-v2 \
  --security-opt systempaths=unconfined \
  --security-opt "seccomp=$seccomp_file" \
  --entrypoint python3 "$image_name" - <<'PY'
import json
import os
import pathlib
import socket
import subprocess
import tempfile

def assert_system_paths_blocked():
  for path in ("/proc/keys", "/proc/interrupts", "/proc/kcore"):
    try:
      fd = os.open(path, os.O_RDONLY)
    except PermissionError:
      continue
    else:
      os.close(fd)
      raise AssertionError("sensitive system path readable: " + path)
  # Open without truncation or writing; verify denial without changing sysctls.
  try:
    fd = os.open("/proc/sys/kernel/shmmax", os.O_WRONLY)
  except PermissionError:
    pass
  else:
    os.close(fd)
    raise AssertionError("system path writable")

assert_system_paths_blocked()
print("PASS: outer sensitive proc paths denied", flush=True)

with tempfile.TemporaryDirectory(prefix="media-policy-") as directory:
  root = pathlib.Path(directory)
  work = root / "work"
  work.mkdir()
  outside = root / "outside.txt"
  outside.write_text("test fixture, not a secret")
  listener = socket.socket()
  listener.bind(("127.0.0.1", 0))
  listener.listen(1)
  port = listener.getsockname()[1]
  args = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session",
    "--clearenv", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--dir", "/etc", "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--bind", str(work), "/work", "--chdir", "/work",
    "--setenv", "PATH", "/usr/bin:/usr/local/bin", "--setenv", "LC_ALL", "C.UTF-8",
    "--", "/usr/bin/prlimit", "--cpu=30", "--as=2147483648", "--nofile=128",
    "--fsize=104857600", "--"]

  def run(command):
    result = subprocess.run(args + command, text=True, capture_output=True, timeout=60,
      env={"PATH": "/usr/bin:/usr/local/bin:/bin", "MEDIA_POLICY_TEST_SECRET": "fixture"})
    if result.returncode:
      raise RuntimeError(result.stderr[-4000:])
    return result.stdout

  checks = r'''
import os, pathlib, socket, sys
assert not pathlib.Path(sys.argv[1]).exists(), "task-external file visible"
assert not pathlib.Path("/app").exists(), "application directory visible"
assert "MEDIA_POLICY_TEST_SECRET" not in os.environ, "parent environment inherited"
status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
assert int(status["CapEff"].strip(), 16) == 0, "effective capabilities retained"
assert status["NoNewPrivs"].strip() == "1", "no-new-privileges missing"
assert status["Seccomp"].strip() == "2", "seccomp filter missing"
assert os.readlink("/proc/self/ns/pid") != pathlib.Path("/work/parent-pidns").read_text(), "parent PID namespace retained"
for name in ("/proc/keys", "/proc/interrupts", "/proc/kcore"):
  try:
    fd = os.open(name, os.O_RDONLY)
  except PermissionError:
    pass
  else:
    os.close(fd)
    raise AssertionError("sensitive system path readable: " + name)
pathlib.Path("/work/result.txt").write_text("ok")
for name in (sys.argv[1], "/usr/media-policy-test"):
  try:
    pathlib.Path(name).write_text("unexpected")
  except OSError:
    pass
  else:
    raise AssertionError("unexpected write access: " + name)
try:
  connection = socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=2)
except OSError:
  pass
else:
  connection.close()
  raise AssertionError("decoder reached parent network namespace")
print("PASS: filesystem, environment, capabilities, seccomp and network isolation")
'''
  (work / "parent-pidns").write_text(os.readlink("/proc/self/ns/pid"))
  print(run(["/usr/bin/python3", "-I", "-c", checks, str(outside), str(port)]).strip(), flush=True)
  assert (work / "result.txt").read_text() == "ok"
  assert outside.read_text() == "test fixture, not a secret"
  print("PASS: sandboxed yt-dlp " + run(["/usr/local/bin/yt-dlp", "--ignore-config", "--no-plugin-dirs", "--version"]).strip())
  run(["/usr/bin/ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
    "color=c=black:s=64x64:r=1", "-t", "1", "-threads", "1", "-c:v", "libx264", "/work/probe.mp4"])
  info = json.loads(run(["/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", "/work/probe.mp4"]))
  assert float(info["format"]["duration"]) > 0
  print("PASS: sandboxed FFmpeg encode and FFprobe read")
  listener.close()
print("PASS: media sandbox preflight (no model calls or business data)")
PY
