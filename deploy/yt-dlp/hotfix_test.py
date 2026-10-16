import importlib.util
from pathlib import Path
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


root = Path(__file__).resolve().parent
bridge = load('bridge', root.parent / 'media-analysis-proxy-bridge.py')
builder = load('builder', root / 'build-douyin-zipapp.py')


class HotfixTests(unittest.TestCase):
    def test_only_normalized_douyin_positionals_use_hotfix(self):
        for url in ('https://v.douyin.com/Opl7-ZVVzec',
                    'https://www.douyin.com/video/7658289800398589193'):
            args = ['--ignore-config', '--no-plugin-dirs', '--proxy', 'http://127.0.0.1:3189', '--', url]
            command = bridge.downloader_command(args)
            self.assertEqual(command[0], '/usr/local/bin/yt-dlp-douyin')
            self.assertEqual(command[1:], args)

    def test_other_tools_and_sources_keep_original_binary(self):
        cases = [['--ignore-config', '--no-plugin-dirs', '--version'],
                 ['--load-info-json', '/work/browser-source.json'],
                 ['--referer', 'https://www.douyin.com/video/123456']]
        for url in ('https://www.bilibili.com/video/BV1234567890',
                    'https://www.xiaohongshu.com/explore/123',
                    'http://www.douyin.com/video/123456',
                    'https://www.douyin.com.evil.test/video/123456',
                    'https://user@www.douyin.com/video/123456',
                    'https://www.douyin.com:443/video/123456',
                    'https://www.douyin.com/video/123456?x=1',
                    'https://www.douyin.com/video/123456#fragment',
                    'https://www.douyin.com/user/123456'):
            cases.append(['--', url])
        for args in cases:
            with self.subTest(args=args):
                self.assertEqual(bridge.downloader_command(args), ['/usr/local/bin/yt-dlp', *args])

    def test_unknown_version_and_tampered_archive_fail_before_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            archive, patch, output = path / 'archive', path / 'patch', path / 'output'
            archive.write_bytes(b'not the pinned release')
            patch.write_bytes(b'not the reviewed patch')
            with self.assertRaisesRegex(ValueError, 'requires yt-dlp'):
                builder.build(archive, patch, output, '2026.10.16')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                builder.build(archive, patch, output, builder.VERSION)
            self.assertFalse(output.exists())

    def test_vendored_patch_is_the_reviewed_snapshot(self):
        builder.verify((root / 'douyin-17826.patch').read_bytes(), builder.PATCH_SHA256)


if __name__ == '__main__':
    unittest.main()
