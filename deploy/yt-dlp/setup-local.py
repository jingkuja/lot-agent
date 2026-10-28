"""Install the same pinned Douyin zipapp as the media image, without changing Homebrew."""
import importlib.util
from pathlib import Path
import platform
import tempfile
import urllib.request


def main():
    if platform.system() != 'Darwin':
        raise RuntimeError('This setup is for macOS; Linux uses Dockerfile.media-analysis')
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('douyin_builder', here / 'build-douyin-zipapp.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    destination = here.parent.parent / 'data/media-tools'
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / f'yt-dlp-douyin-{builder.VERSION}'
    # Build in the destination filesystem, then atomically publish only verified bytes.
    with tempfile.TemporaryDirectory(dir=destination) as temporary:
        scratch = Path(temporary)
        archive, output = scratch / 'official', scratch / 'patched'
        url = f'https://github.com/yt-dlp/yt-dlp/releases/download/{builder.VERSION}/yt-dlp'
        with urllib.request.urlopen(url, timeout=60) as response:
            content = response.read(20 * 1024 * 1024 + 1)
        builder.verify(content, builder.ARCHIVE_SHA256)
        archive.write_bytes(content)
        builder.build(archive, here / 'douyin-17826.patch', output, builder.VERSION)
        output.replace(target)
    print(f'Installed verified Douyin downloader: {target}')
    print('Restart the media-analysis worker. Keep YTDLP_VERSION matched to your Homebrew yt-dlp.')


if __name__ == '__main__':
    main()
