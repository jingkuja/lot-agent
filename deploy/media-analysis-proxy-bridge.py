"""Task-local TCP -> Unix bridge. Runs inside a network-less namespace.

The only network capability is a single mounted Unix socket owned by the
parent's HTTPS egress policy. No credentials or application files are mounted.
"""
import selectors
import re
import socket
import subprocess
import sys
import threading
from urllib.parse import urlsplit


def relay(client):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect('/egress.sock')
        with selectors.DefaultSelector() as events:
            events.register(client, selectors.EVENT_READ, upstream)
            events.register(upstream, selectors.EVENT_READ, client)
            while True:
                ready = events.select(30)
                if not ready:
                    break
                for key, _ in ready:
                    data = key.fileobj.recv(65536)
                    if not data:
                        return
                    key.data.sendall(data)
    except OSError:
        pass
    finally:
        client.close()
        upstream.close()


def serve(listener):
    while True:
        client, _ = listener.accept()
        client.settimeout(30)
        threading.Thread(target=relay, args=(client,), daemon=True).start()


def downloader_command(args):
    binary = '/usr/local/bin/yt-dlp'
    # Only the server's normalized positional URL selects the pinned hotfix.
    # Version checks, other platforms and browser metadata use the original tool.
    if len(args) >= 2 and args[-2] == '--':
        source = urlsplit(args[-1])
        if source.scheme == 'https' and not source.query and not source.fragment and (
            source.netloc == 'v.douyin.com' and re.fullmatch(r'/[A-Za-z0-9_-]{3,80}', source.path)
            or source.netloc == 'www.douyin.com' and re.fullmatch(r'/video/\d{5,30}', source.path)
        ):
            binary = '/usr/local/bin/yt-dlp-douyin'
    return [binary, *args]


def main():
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', 3189))
    listener.listen(8)
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    # argv comes from the server's fixed command builder, never from request JSON.
    # Preserve only Chromium's private debugging pipes, not a debugging TCP port.
    if sys.argv[1:2] == ['--browser']:
        # Debian's wrapper sources /etc/chromium.d and user settings. Run the
        # packaged binary directly inside our minimal /usr-only sandbox.
        return subprocess.call(['/usr/lib/chromium/chromium', *sys.argv[2:]], pass_fds=(3, 4))
    return subprocess.call(downloader_command(sys.argv[1:]))


if __name__ == '__main__':
    sys.exit(main())
