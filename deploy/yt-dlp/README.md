# Pinned Douyin extractor compatibility fix

The official `2026.08.19` Douyin extractor does not provide the request signature
now required by `/aweme/v1/web/aweme/detail/`. A production probe on 2026-10-16
received HTTP 403 with `Blocked by ArgusSecurityPlugin Signature Not Found`.
This is not evidence of an account login requirement or a geographical ban.

The vendored patch is [yt-dlp PR #17826](https://github.com/yt-dlp/yt-dlp/pull/17826),
head `edf5ca18f756b1a21f56c87aaf1aef7ef8d3520e` (open, not merged at review time).
It is submitted under yt-dlp's Unlicense/public-domain contribution terms.
See also [the upstream investigation](https://github.com/yt-dlp/yt-dlp/issues/9667).
The original patch is retained byte-for-byte; no moving Git branch is installed.

`build-douyin-zipapp.py` verifies the official portable release, patch, original
extractor and patched extractor by SHA256. It changes only the extractor entry
and creates `/usr/local/bin/yt-dlp-douyin`. The version must remain `2026.08.19`
until this patch is reviewed for a new release. The normal platform-specific
binary and its existing `YTDLP_SHA256` setting are unchanged.

Only normalized Douyin URLs produced by the server use this executable. Every
request still uses the task's pinned HTTPS egress, filesystem sandbox, limits,
cancellation and `--no-plugin-dirs`. Anonymous state stays in the child process;
no shared profile, account cookies or credentials are added. The existing
browser fallback remains available. All other platforms and `--load-info-json`
continue using the original binary.

Build prerequisites are Python 3.10+, `patch` and the pinned official zipapp.
For macOS development, run `pnpm setup:marketing-analysis:local` once, then
restart the media worker. This verifies the same release and patch and atomically
installs the zipapp in the Git-ignored `data/media-tools/` directory. The macOS
runner selects it for normalized Douyin URLs and grants read access only to that
file inside the existing sandbox. Missing installation fails closed. Keep
`YTDLP_VERSION` matched to Homebrew yt-dlp; version checks, other platforms and
browser metadata still use Homebrew. No global installation or automatic task-time
download is performed.

The Dockerfile downloads it at build time, never while executing a user task.
To reproduce locally, pass the downloaded archive, patch, destination and version:

```bash
python3 deploy/yt-dlp/build-douyin-zipapp.py /tmp/yt-dlp \
  deploy/yt-dlp/douyin-17826.patch /tmp/yt-dlp-douyin 2026.08.19
python3 -m unittest discover -s deploy/yt-dlp -p '*test.py'
```

When the upstream fix is released, validate it against the production network,
remove this hotfix and dispatch rule together, and update the pinned release and
SHA256. Do not layer an unreviewed newer version beneath this patch.
