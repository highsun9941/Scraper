import base64
import contextlib
import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('media_downloader', Path(__file__).parents[1] / 'download-media.py')
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)
GIF = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L9sAAAAASUVORK5CYII=')
SVG = b'<?xml version="1.0"?>\n<!-- icon --><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
MP4 = b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00\x00\x00\x08mdat'
PLAYLIST = b'#EXTM3U\n#EXTINF:1,\nsegment.ts\n'
MPD = b'<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>'


class Handler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.requests.append((self.path, self.headers.get('Referer'), self.headers.get('User-Agent')))
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/animation.gif')
            self.end_headers()
            return
        responses = {
            '/animation.gif': (200, 'image/gif', GIF),
            '/extensionless': (200, 'image/png', PNG),
            '/wrong-name.jpg': (200, 'image/gif', GIF),
            '/icon': (200, 'image/svg+xml', SVG),
            '/video': (200, 'video/mp4', MP4),
            '/playlist': (200, 'application/vnd.apple.mpegurl', PLAYLIST),
            '/dash': (200, 'application/dash+xml', MPD),
            '/ok.gif': (200, 'text/plain', b'OK'),
            '/false-type.gif': (200, 'image/gif', b'OK'),
            '/json.jpg': (200, 'application/json', b'{"status":404}'),
            '/html.jpg': (200, 'text/html', b'<html>Access Denied</html>'),
            '/denied.jpg': (403, 'text/html', b'Access Denied'),
            '/short.png': (200, 'image/png', PNG),
        }
        status, content_type, body = responses.get(self.path, (404, 'application/json', b'{"status":404}'))
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body) + (100 if self.path == '/short.png' else 0)))
        self.end_headers()
        self.wfile.write(body)


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def download(self, path, order=1):
        return downloader.download_one({'order': order, 'url': self.base + path, 'type': 'IMAGE'},
                                       self.folder, 4, 'https://shop.example/', 2)

    def test_youtube_link_is_saved_without_requesting_html(self):
        job = {'order': 128, 'type': 'EMBED', 'url': 'https://www.youtube.com/watch?v=M7lc1UVf-VE'}
        with mock.patch.object(downloader.urllib.request, 'urlopen', side_effect=AssertionError('must not fetch HTML')):
            result = downloader.download_one(job, self.folder, 4, '', 2)
        self.assertEqual(result['status'], 'link')
        self.assertEqual(result['filename'], '0128.url')
        self.assertIn(job['url'], (self.folder / '0128.url').read_text())
        self.assertFalse(list(self.folder.glob('*.mp4')))

    def test_bytes_and_actual_extension_preserved(self):
        for i, (path, data, extension) in enumerate([
            ('/animation.gif', GIF, '.gif'), ('/extensionless', PNG, '.png'),
            ('/wrong-name.jpg', GIF, '.gif'), ('/icon', SVG, '.svg'), ('/video', MP4, '.mp4')
        ], 1):
            with self.subTest(path=path):
                result = self.download(path, i)
                self.assertEqual(result['status'], 'saved')
                self.assertEqual(result['filename'], f'{i:04d}{extension}')
                self.assertEqual((self.folder / result['filename']).read_bytes(), data)

    def test_plain_text_html_and_json_are_not_saved_as_images(self):
        for path in ['/ok.gif', '/false-type.gif', '/json.jpg', '/html.jpg']:
            with self.subTest(path=path):
                result = self.download(path)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['http_status'], 200)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_403_and_404_are_logged_and_partial_files_are_removed(self):
        for path, status in [('/denied.jpg', 403), ('/missing.jpg', 404)]:
            result = self.download(path)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['http_status'], status)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_incomplete_response_is_rejected(self):
        result = self.download('/short.png')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('중간에 끊겼', result['message'])
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_redirect_and_origin_referer(self):
        result = self.download('/redirect')
        self.assertEqual(result['status'], 'saved')
        self.assertEqual((self.folder / result['filename']).read_bytes(), GIF)
        self.assertIn(('/animation.gif', 'https://shop.example/', 'ScraperMediaDownloader/1.0'), Handler.requests)
        self.assertEqual(downloader.origin_referer('https://shop.example/item?id=secret#x'), 'https://shop.example/')

    def test_playlists_remain_playlists(self):
        for i, (path, suffix, data) in enumerate([('/playlist', '.m3u8', PLAYLIST), ('/dash', '.mpd', MPD)], 1):
            result = self.download(path, i)
            self.assertEqual(result['status'], 'playlist')
            self.assertEqual(result['filename'], f'{i:04d}{suffix}')
            self.assertEqual((self.folder / result['filename']).read_bytes(), data)

    def test_data_urls(self):
        for i, (url, expected) in enumerate([
            ('data:image/gif;base64,' + base64.b64encode(GIF).decode(), GIF),
            ('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E',
             b'<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        ], 1):
            result = downloader.download_one({'order': i, 'url': url, 'type': 'IMAGE'}, self.folder, 4, '', 2)
            self.assertEqual(result['status'], 'saved')
            self.assertEqual((self.folder / result['filename']).read_bytes(), expected)

    def test_blob_tracking_and_unsupported_schemes_skip_without_network(self):
        before = len(Handler.requests)
        for url in ['blob:https://shop.example/session', 'https://mercury.coupang.com/e.gif?r=test',
                    'file:///private/image.jpg']:
            result = downloader.download_one({'order': 1, 'url': url, 'type': 'IMAGE'}, self.folder, 4, '', 2)
            self.assertEqual(result['status'], 'skipped')
        self.assertEqual(len(Handler.requests), before)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_json_and_text_lists_deduplicate_without_changing_order(self):
        path = self.folder / '목록.json'
        path.write_text(json.dumps({'pageUrl': 'https://shop.example/item', 'items': [
            {'order': 300, 'url': self.base + '/animation.gif'},
            {'order': 4, 'url': self.base + '/extensionless'},
            {'url': self.base + '/animation.gif'}]}), encoding='utf-8-sig')
        jobs, page = downloader.load_manifest(path)
        self.assertEqual([job['order'] for job in jobs], [1, 2])
        self.assertEqual([job['url'] for job in jobs], [self.base + '/animation.gif', self.base + '/extensionless'])
        self.assertEqual(page, 'https://shop.example/item')
        text = self.folder / 'media-urls.txt'
        text.write_text(f'# list\n{jobs[0]["url"]}\n{jobs[1]["url"]}\n{jobs[0]["url"]}\n', encoding='utf-8')
        self.assertEqual(downloader.load_manifest(text)[0], jobs)

    def test_cli_runs_batch_and_reports_all_results_in_manifest_order(self):
        manifest = self.folder / '상품 목록.json'
        manifest.write_text(json.dumps({'pageUrl': 'https://shop.example/item', 'items': [
            {'url': self.base + '/animation.gif'}, {'url': self.base + '/missing.jpg'},
            {'url': self.base + '/extensionless'}, {'url': 'blob:https://shop.example/session'},
            {'url': self.base + '/playlist'}]}), encoding='utf-8')
        target = self.folder / '결과 폴더'
        process = subprocess.run([sys.executable, str(Path(downloader.__file__)), str(manifest),
                                  '--output', str(target), '--workers', '3', '--timeout', '2'],
                                 capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
        report = json.loads((target / 'download-report.json').read_text(encoding='utf-8'))
        self.assertEqual([row['order'] for row in report], [1, 2, 3, 4, 5])
        self.assertEqual([row['status'] for row in report], ['saved', 'failed', 'saved', 'skipped', 'playlist'])
        self.assertEqual((target / '0001.gif').read_bytes(), GIF)
        self.assertEqual((target / '0003.png').read_bytes(), PNG)
        self.assertEqual((target / '0005.m3u8').read_bytes(), PLAYLIST)
        with (target / 'failed.csv').open(encoding='utf-8-sig', newline='') as source:
            self.assertEqual([row['order'] for row in csv.DictReader(source)], ['2', '4'])
        self.assertEqual(list(target.glob('*.part')), [])

    def test_existing_output_folder_is_not_overwritten(self):
        manifest = self.folder / 'media.txt'
        manifest.write_text(self.base + '/animation.gif', encoding='utf-8')
        sentinel = self.folder / 'keep.txt'
        sentinel.write_text('keep', encoding='utf-8')
        with contextlib.redirect_stderr(io.StringIO()):
            code = downloader.main([str(manifest), '--output', str(self.folder)])
        self.assertEqual(code, 1)
        self.assertEqual(sentinel.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
