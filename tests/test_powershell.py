"""PowerShell integration checks. Developer tests need Python and a PowerShell
runtime; users running the downloader only need Windows PowerShell 5.1.
Set SCRAPER_TEST_POWERSHELL to choose a portable test runtime.
"""
import base64
import csv
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import quote

from test_downloader import Handler, ThreadingHTTPServer, GIF, PNG, SVG, MP4, PLAYLIST, MPD

POWERSHELL = os.environ.get('SCRAPER_TEST_POWERSHELL') or shutil.which('powershell') or shutil.which('pwsh')
SCRIPT = Path(__file__).parents[1] / 'download-media.ps1'


class TimeoutHandler(Handler):
    def do_GET(self):
        try:
            if self.path == '/slow-headers':
                time.sleep(2)
                self.path = '/animation.gif'
            elif self.path == '/slow-body':
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(PNG)))
                self.end_headers()
                self.wfile.write(PNG[:8])
                self.wfile.flush()
                time.sleep(2)
                self.wfile.write(PNG[8:])
                return
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass


@unittest.skipUnless(POWERSHELL, 'PowerShell runtime is required for this integration suite')
class PowerShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), TimeoutHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='powershell-media-')
        self.folder = Path(self.directory.name)
        self.output = self.folder / '결과 폴더'

    def tearDown(self):
        self.directory.cleanup()

    def run_tool(self, document, *, only_failed=False, extra=(), csv_text=None, txt=None):
        source = self.folder / ('상품 목록.csv' if csv_text is not None else '상품 목록.txt' if txt is not None else '상품 목록.json')
        source.write_text(csv_text if csv_text is not None else txt if txt is not None else json.dumps(document, ensure_ascii=False), encoding='utf-8-sig')
        command = [POWERSHELL, '-NoLogo', '-NoProfile', '-File', str(SCRIPT), '-Manifest', str(source), '-OutputPath', str(self.output)]
        if only_failed:
            command += ['-OnlyFailed']
        command += list(extra)
        result = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=30)
        report_path = self.output / 'download-report.json'
        report = json.loads(report_path.read_text(encoding='utf-8-sig')) if report_path.exists() else None
        return result, report

    def manifest(self, paths):
        return {'pageUrl': 'https://shop.example/item?token=private#anchor', 'items': [{'url': self.base + path} for path in paths]}

    def test_media_bytes_actual_extensions_and_referer(self):
        result, report = self.run_tool(self.manifest(['/animation.gif', '/extensionless', '/wrong-name.jpg', '/icon', '/video', '/redirect']))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = [('0001.gif', GIF), ('0002.png', PNG), ('0003.gif', GIF), ('0004.svg', SVG), ('0005.mp4', MP4), ('0006.gif', GIF)]
        self.assertEqual([row['filename'] for row in report['results']], [name for name, _ in expected])
        for name, data in expected:
            self.assertEqual((self.output / name).read_bytes(), data)
        self.assertIn(('/animation.gif', 'https://shop.example/', 'ScraperMediaDownloader/1.0'), Handler.requests)
        self.assertTrue((self.output / 'failed.csv').read_bytes().startswith(b'\xef\xbb\xbf'))
        with (self.output / 'failed.csv').open(encoding='utf-8-sig', newline='') as source:
            self.assertEqual(list(csv.DictReader(source)), [])

    def test_false_media_and_http_failures_are_reported_and_batch_continues(self):
        result, report = self.run_tool(self.manifest(['/ok.gif', '/false-type.gif', '/html.jpg', '/json.jpg', '/denied.jpg', '/missing.jpg', '/animation.gif']))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual([row['status'] for row in report['results']], ['failed'] * 6 + ['saved'])
        self.assertEqual([row['http_status'] for row in report['results'][:6]], [200, 200, 200, 200, 403, 404])
        self.assertEqual((self.output / '0007.gif').read_bytes(), GIF)
        self.assertFalse(list(self.output.glob('*.part')))
        with (self.output / 'failed.csv').open(encoding='utf-8-sig', newline='') as source:
            self.assertEqual(len(list(csv.DictReader(source))), 6)

    def test_report_input_only_failed_and_original_order(self):
        document = {'pageUrl': 'https://shop.example/item', 'results': [
            {'order': 3, 'url': self.base + '/animation.gif', 'status': 'packed'},
            {'order': 7, 'url': self.base + '/extensionless', 'status': 'failed'}]}
        result, report = self.run_tool(document, only_failed=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(report['results']), 1)
        self.assertEqual(report['results'][0]['filename'], '0007.png')
        self.assertEqual(report['results'][0]['source_order'], 7)

    def test_inline_media_and_unicode_percent_decoding(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>상품 + 그림</title></svg>'.encode('utf-8')
        document = [
            'data:image/gif;base64,' + base64.b64encode(GIF).decode().rstrip('='),
            'data:image/svg+xml,' + quote(svg)]
        result, report = self.run_tool(document)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.output / '0001.gif').read_bytes(), GIF)
        self.assertEqual((self.output / '0002.svg').read_bytes(), svg)

    def test_csv_text_lists_and_exact_url_deduplication(self):
        result, report = self.run_tool(None, csv_text='order,url,status\r\n4,' + self.base + '/animation.gif,failed\r\n5,' + self.base + '/animation.gif,failed\r\n8,' + self.base + '/extensionless,failed\r\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([row['filename'] for row in report['results']], ['0004.gif', '0008.png'])
        self.output = self.folder / '다른 결과'
        result, report = self.run_tool(None, txt='# list\n' + self.base + '/animation.gif\n' + self.base + '/extensionless\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([row['filename'] for row in report['results']], ['0001.gif', '0002.png'])

    def test_playlists_and_unusable_addresses(self):
        document = self.manifest(['/playlist', '/dash'])
        document['items'] += [{'url': 'blob:https://shop.example/session'}, {'url': 'https://mercury.coupang.com/e.gif?t=1'}, {'url': 'file:///private/image.jpg'}]
        result, report = self.run_tool(document)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual([row['status'] for row in report['results']], ['playlist', 'playlist', 'skipped', 'skipped', 'skipped'])
        self.assertEqual((self.output / '0001.m3u8').read_bytes(), PLAYLIST)
        self.assertEqual((self.output / '0002.mpd').read_bytes(), MPD)

    def test_truncated_response_does_not_leave_a_media_file(self):
        result, report = self.run_tool(self.manifest(['/short.png']), extra=('-TimeoutSec', '2'))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(report['results'][0]['status'], 'failed')
        self.assertFalse(list(self.output.glob('*.png')))
        self.assertFalse(list(self.output.glob('*.part')))

    def test_existing_folder_is_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'keep.txt'
        sentinel.write_text('keep', encoding='utf-8')
        result, report = self.run_tool(self.manifest(['/animation.gif']))
        self.assertEqual(result.returncode, 1)
        self.assertIsNone(report)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_request_deadline_during_headers_and_body(self):
        for path in ('/slow-headers', '/slow-body'):
            with self.subTest(path=path):
                self.output = self.folder / path.lstrip('/')
                result, report = self.run_tool(self.manifest([path]), extra=('-TimeoutSec', '1'))
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertEqual(report['results'][0]['status'], 'failed')
                self.assertIn('대기 시간', report['results'][0]['message'])
                self.assertFalse(list(self.output.glob('*.png')))
                self.assertFalse(list(self.output.glob('*.part')))

    def test_file_size_limit(self):
        payload = b'GIF89a' + b'x' * (1024 * 1024)
        document = ['data:image/gif;base64,' + base64.b64encode(payload).decode()]
        result, report = self.run_tool(document, extra=('-MaxFileMB', '1'))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(report['results'][0]['status'], 'failed')
        self.assertIn('크기 제한', report['results'][0]['message'])
        self.assertFalse(list(self.output.glob('*.gif')))


if __name__ == '__main__':
    unittest.main()
