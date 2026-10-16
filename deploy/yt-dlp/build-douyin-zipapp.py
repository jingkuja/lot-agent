"""Apply one reviewed extractor patch to a SHA256-pinned official zipapp.

Build time only. No plugins or downloaded source are loaded at task runtime.
The original platform-specific yt-dlp remains the default for other platforms.
"""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

VERSION = '2026.08.19'
ARCHIVE_SHA256 = '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6'
PATCH_SHA256 = '5398752f98c3fb12102fbd57b34ad217c219eb3e2584dd650a05049ec2be6ad0'
ORIGINAL_SHA256 = '3257fdea744811ea2e1bfee665a97d6ab85517339ee672f2e43e238e6b997c9e'
PATCHED_SHA256 = '88a853668645068325334f6c670bab3c989dacee30f0e6cc2acacd74087d42e0'
EXTRACTOR = 'yt_dlp/extractor/tiktok.py'


def verify(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Pinned Douyin dependency checksum mismatch')


def build(archive, patch, output, version):
    if version != VERSION:
        raise ValueError('Douyin hotfix requires yt-dlp 2026.08.19; review the hotfix before upgrading')
    verify(archive.read_bytes(), ARCHIVE_SHA256)
    patch_data = patch.read_bytes()
    verify(patch_data, PATCH_SHA256)
    with zipfile.ZipFile(archive) as source, tempfile.TemporaryDirectory() as directory:
        original = source.read(EXTRACTOR)
        verify(original, ORIGINAL_SHA256)
        target = Path(directory) / EXTRACTOR
        target.parent.mkdir(parents=True)
        target.write_bytes(original)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', directory],
                       input=patch_data, check=True, capture_output=True)
        patched = target.read_bytes()
        verify(patched, PATCHED_SHA256)
        # Preserve every other upstream entry and its metadata. The patch cannot
        # add executable options, plugins, network code or files beyond this entry.
        output.write_bytes(b'#!/usr/bin/env python3\n')
        with zipfile.ZipFile(output, 'a') as result:
            for entry in source.infolist():
                result.writestr(entry, patched if entry.filename == EXTRACTOR else source.read(entry))
        output.chmod(0o755)


if __name__ == '__main__':
    build(*(Path(value) for value in sys.argv[1:4]), sys.argv[4])
