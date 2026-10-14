"""Task-local TCP -> Unix bridge. Runs inside a network-less namespace.

The only network capability is a single mounted Unix socket owned by the
parent's HTTPS egress policy. No credentials or application files are mounted.
"""
import selectors
import socket
import subprocess
import sys
import threading


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


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', 3189))
listener.listen(8)
threading.Thread(target=serve, args=(listener,), daemon=True).start()
# argv comes from the server's fixed command builder, never from request JSON.
sys.exit(subprocess.call(['/usr/local/bin/yt-dlp', *sys.argv[1:]]))
