"""Video download tests, including a local HLS server; no YouTube/Coupang requests."""
import contextlib
import csv
import http.server
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import threading
import unittest
import urllib.parse
from unittest import mock

spec = importlib.util.spec_from_file_location('video_downloader', Path(__file__).parents[1] / 'download-videos.py')
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)
        self.manifest = self.folder / 'media-manifest.json'

    def tearDown(self):
        self.directory.cleanup()

    def test_only_video_entries_are_selected_with_full_urls_and_original_orders(self):
        signed = 'https://video.example/review.m3u8?signature=complete%2Fvalue&expires=999'
        self.manifest.write_text(json.dumps({'pageUrl': 'https://shop.example/product', 'items': [
            {'order': 128, 'type': 'IMAGE', 'url': 'https://video.example/origin_thumbnail.0000002.jpg'},
            {'order': 200, 'type': 'STREAM', 'url': signed},
            {'order': 400, 'type': 'EMBED', 'url': 'https://www.youtube.com/watch?v=M7lc1UVf-VE'},
            {'order': 401, 'type': 'STREAM', 'url': signed}], 'pendingVideos': [{'thumbnailUrl': 'thumb'}]}))
        jobs, page, pending = downloader.load_videos(self.manifest)
        self.assertEqual([job['order'] for job in jobs], [200, 400])
        self.assertEqual(jobs[0]['url'], signed)
        self.assertEqual(page, 'https://shop.example/product')
        self.assertEqual(pending, 1)

    def test_type_free_download_report_selects_playlists_with_original_numbers(self):
        first = 'https://video.example/origin.m3u8?signature=whole%2Fvalue&expires=999'
        second = 'https://video.example/extensionless?token=full'
        self.manifest.write_text(json.dumps({'pageUrl': 'https://shop.example/product', 'results': [
            {'order': 1, 'status': 'saved', 'url': 'https://video.example/origin_thumbnail.0000002.jpg'},
            {'order': 121, 'status': 'playlist', 'url': first},
            {'order': 156, 'status': 'playlist', 'url': second, 'content_type': 'application/vnd.apple.mpegurl'},
            {'order': 157, 'status': 'saved', 'url': 'https://video.example/image.jpg', 'content_type': 'video/mp4'}
        ]}))
        jobs, page, pending = downloader.load_videos(self.manifest)
        self.assertEqual(jobs, [{'order': 121, 'type': 'STREAM', 'url': first}, {'order': 156, 'type': 'STREAM', 'url': second}])
        self.assertEqual(page, 'https://shop.example/product')
        self.assertEqual(pending, 0)

    def test_csv_report_accepts_bom_multiline_messages_and_preserves_orders(self):
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=['order', 'status', 'url', 'message'])
        writer.writeheader()
        writer.writerow({'order': '121', 'status': 'playlist', 'url': 'https://video.example/a.m3u8?token=whole&x=2', 'message': 'first\nsecond'})
        writer.writerow({'order': '156', 'status': 'playlist', 'url': 'https://video.example/b.mpd', 'message': ''})
        path = self.folder / 'download-report.CSV'
        path.write_text(output.getvalue(), encoding='utf-8-sig')
        jobs, page, _ = downloader.load_videos(path)
        self.assertEqual([job['order'] for job in jobs], [121, 156])
        self.assertEqual(jobs[0]['url'], 'https://video.example/a.m3u8?token=whole&x=2')
        self.assertEqual(page, '')

    def test_stream_missing_ffmpeg_fails_before_creating_a_batch(self):
        self.manifest.write_text(json.dumps({'results': [{'order': 121, 'url': 'https://video.example/a.m3u8'}]}))
        output = self.folder / 'output'
        with mock.patch.object(downloader, 'media_tools', side_effect=ValueError('ffmpeg and ffprobe required')), contextlib.redirect_stderr(io.StringIO()):
            status = downloader.main([str(self.manifest), '--output', str(output)])
        self.assertEqual(status, 1)
        self.assertFalse(output.exists())

    def test_failed_stream_removes_only_its_partial_file_and_reports_failure(self):
        def run(command, **options):
            Path(command[-1]).write_bytes(b'incomplete video')
            return subprocess.CompletedProcess(command, 1, '', 'HTTP 403')
        with mock.patch.object(downloader, 'media_tools', return_value=('ffmpeg', 'ffprobe')), mock.patch.object(downloader.subprocess, 'run', side_effect=run):
            result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': 'https://video.example/a.m3u8'}, self.folder, '', 20)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('403', result['message'])
        self.assertFalse((self.folder / '0121.mp4').exists())
        self.assertFalse((self.folder / '0121.partial.mp4').exists())

    def test_audio_only_probe_result_is_not_reported_as_a_saved_video(self):
        def run(command, **options):
            if command[0] == 'ffmpeg':
                Path(command[-1]).write_bytes(b'candidate media')
                return subprocess.CompletedProcess(command, 0, '', '')
            return subprocess.CompletedProcess(command, 0, json.dumps({'format': {'duration': '2', 'format_name': 'mp4'}, 'streams': [{'codec_type': 'audio'}]}), '')
        with mock.patch.object(downloader, 'media_tools', return_value=('ffmpeg', 'ffprobe')), mock.patch.object(downloader.subprocess, 'run', side_effect=run):
            result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': 'https://video.example/a.m3u8'}, self.folder, '', 20)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['filename'], '')
        self.assertFalse((self.folder / '0121.partial.mp4').exists())

    def test_stream_timeout_cleans_up_partial_output(self):
        def run(command, **options):
            Path(command[-1]).write_bytes(b'partial')
            raise subprocess.TimeoutExpired(command, 20)
        with mock.patch.object(downloader, 'media_tools', return_value=('ffmpeg', 'ffprobe')), mock.patch.object(downloader.subprocess, 'run', side_effect=run):
            result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': 'https://video.example/a.m3u8'}, self.folder, '', 20)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('시간 제한', result['message'])
        self.assertFalse((self.folder / '0121.partial.mp4').exists())

    def test_existing_mp4_and_partial_files_are_never_overwritten_or_deleted(self):
        for name in ('0121.mp4', '0121.partial.mp4'):
            path = self.folder / name
            path.write_bytes(b'existing file')
            with mock.patch.object(downloader, 'media_tools', return_value=('ffmpeg', 'ffprobe')), mock.patch.object(downloader.subprocess, 'run', side_effect=AssertionError('must not launch')):
                result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': 'https://video.example/a.m3u8'}, self.folder, '', 20)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(path.read_bytes(), b'existing file')
            path.unlink()

    def test_blob_and_credentials_are_never_sent_to_yt_dlp(self):
        for url in ['blob:https://shop.example/session', 'https://user:password@video.example/file.mp4']:
            with mock.patch.object(downloader.subprocess, 'run', side_effect=AssertionError('must not launch')):
                result = downloader.download_video({'order': 2, 'type': 'VIDEO', 'url': url}, self.folder, '', 20)
            self.assertIn(result['status'], ['skipped', 'failed'])

    def test_download_passes_url_as_one_argument_and_verifies_the_final_file(self):
        signed = 'https://video.example/video.mp4?signature=full&literal=$(echo-no-shell)'
        job = {'order': 128, 'type': 'VIDEO', 'url': signed}
        file = self.folder / '0128.mp4'
        def run(command, **options):
            self.assertEqual(command[-2:], ['--', signed])
            self.assertNotIn('shell', options)
            self.assertEqual(command[command.index('--referer') + 1], 'https://shop.example/')
            file.write_bytes(b'complete original video')
            return subprocess.CompletedProcess(command, 0, str(file) + '\n', '')
        with mock.patch.object(downloader.subprocess, 'run', side_effect=run):
            result = downloader.download_video(job, self.folder, 'https://shop.example/product?private=query', 20)
        self.assertEqual(result['status'], 'saved')
        self.assertEqual(result['filename'], '0128.mp4')
        self.assertEqual(result['bytes'], len(b'complete original video'))

    def test_youtube_does_not_receive_the_shopping_page_referer(self):
        job = {'order': 1, 'type': 'EMBED', 'url': 'https://www.youtube.com/watch?v=M7lc1UVf-VE'}
        with mock.patch.object(downloader.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'provider denied')) as run:
            result = downloader.download_video(job, self.folder, 'https://shop.example/product', 20)
        self.assertNotIn('--referer', run.call_args.args[0])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('provider denied', result['message'])

    def test_successful_exit_without_a_final_file_is_not_reported_as_saved(self):
        with mock.patch.object(downloader.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            result = downloader.download_video({'order': 1, 'type': 'VIDEO', 'url': 'https://video.example/a.mp4'}, self.folder, '', 20)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('최종 영상 파일', result['message'])

    def test_timeout_is_recorded_as_failure(self):
        with mock.patch.object(downloader.subprocess, 'run', side_effect=subprocess.TimeoutExpired([], 20)):
            result = downloader.download_video({'order': 1, 'type': 'VIDEO', 'url': 'https://video.example/a.mp4'}, self.folder, '', 20)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('시간 제한', result['message'])

    def test_pending_reviews_produce_an_incomplete_exit_and_report_without_overwriting(self):
        self.manifest.write_text(json.dumps({'items': [{'order': 8, 'type': 'VIDEO', 'url': 'https://video.example/a.mp4'}],
                                             'pendingVideos': [{'thumbnailUrl': 'thumb'}]}))
        output = self.folder / 'output'
        with mock.patch.object(downloader.importlib.util, 'find_spec', return_value=object()), mock.patch.object(
                downloader, 'download_video', return_value={'order': 8, 'status': 'saved', 'filename': '0008.mp4', 'bytes': 10}), contextlib.redirect_stdout(io.StringIO()):
            status = downloader.main([str(self.manifest), '--output', str(output)])
            second = downloader.main([str(self.manifest), '--output', str(output)])
        self.assertEqual(status, 2)
        self.assertEqual(second, 1)
        report = json.loads((output / 'video-report.json').read_text())
        self.assertEqual(report['pendingVideoCount'], 1)

    def test_invalid_orders_and_missing_dependency_fail_before_creating_output(self):
        self.manifest.write_text(json.dumps({'items': [{'order': True, 'type': 'VIDEO', 'url': 'https://video.example/a.mp4'}]}))
        with self.assertRaises(ValueError):
            downloader.load_videos(self.manifest)
        self.manifest.write_text(json.dumps({'items': [{'order': 1, 'type': 'VIDEO', 'url': 'https://video.example/a.mp4'}]}))
        with mock.patch.object(downloader.importlib.util, 'find_spec', return_value=None), contextlib.redirect_stderr(io.StringIO()):
            status = downloader.main([str(self.manifest)])
        self.assertEqual(status, 1)
        self.assertFalse((self.folder / 'video-output').exists())


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/ffprobe required for real HLS integration')
class StreamIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.requests = []
        for name, audio in [('av', True), ('silent', False)]:
            folder = cls.root / name
            folder.mkdir()
            command = ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10']
            if audio:
                command += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
            command += ['-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '10']
            if audio:
                command += ['-c:a', 'aac']
            command += ['-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
                        '-hls_segment_filename', str(folder / 'segment-%02d.ts'), str(folder / 'media.m3u8')]
            subprocess.run(command, capture_output=True, timeout=20, check=True)
            (folder / 'master.m3u8').write_text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nmedia.m3u8\n')
        broken = cls.root / 'broken'
        broken.mkdir()
        (broken / 'media.m3u8').write_text('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n'
                                         '#EXTINF:1,\n../av/segment-00.ts\n#EXTINF:1,\nmissing.ts\n#EXT-X-ENDLIST\n')
        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(cls.root), **kwargs)
            def do_GET(self):
                cls.requests.append((self.path, self.headers.get('Referer')))
                if urllib.parse.urlsplit(self.path).path == '/denied.m3u8':
                    self.send_error(403)
                else:
                    super().do_GET()
            def log_message(self, *args):
                pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def test_relative_hls_lists_and_segments_become_a_real_mp4_with_unchanged_video_frames(self):
        for name, audio in [('av', True), ('silent', False)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                self.requests.clear()
                url = self.origin + f'/{name}/master.m3u8?signature=full%2Fvalue&expires=999'
                folder = Path(directory)
                result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': url}, folder,
                                                   self.origin + '/product?private=query', 30)
                self.assertEqual(result['status'], 'saved', result['message'])
                output = folder / '0121.mp4'
                self.assertTrue(output.is_file())
                self.assertEqual(output.read_bytes()[4:8], b'ftyp')
                self.assertGreater(result['duration_seconds'], 1.9)
                self.assertEqual(result['has_audio'], audio)
                self.assertEqual((result['width'], result['height']), (128, 96))
                self.assertIn((f'/{name}/master.m3u8?signature=full%2Fvalue&expires=999', self.origin + '/'), self.requests)
                self.assertTrue(all(referer == self.origin + '/' for _, referer in self.requests))
                self.assertTrue(any(path.endswith('segment-01.ts') for path, _ in self.requests))
                def frames(path):
                    completed = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0', '-f', 'framemd5', '-'],
                                               capture_output=True, text=True, check=True, timeout=20)
                    return [line.rsplit(',', 1)[-1].strip() for line in completed.stdout.splitlines() if line and not line.startswith('#')]
                original = frames(self.root / name / 'media.m3u8')
                self.assertEqual(len(original), 20)
                self.assertEqual(frames(output), original)

    def test_report_reuse_without_yt_dlp_records_http_failure_and_still_saves_the_next_video(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'download-report.json'
            report.write_text(json.dumps({'pageUrl': self.origin + '/product', 'results': [
                {'order': 121, 'status': 'playlist', 'url': self.origin + '/denied.m3u8'},
                {'order': 156, 'status': 'playlist', 'url': self.origin + '/silent/master.m3u8'}
            ]}))
            output = root / 'output'
            with mock.patch.object(downloader.importlib.util, 'find_spec', return_value=None), contextlib.redirect_stdout(io.StringIO()):
                status = downloader.main([str(report), '--output', str(output), '--timeout', '30'])
            self.assertEqual(status, 2)
            result = json.loads((output / 'video-report.json').read_text())['results']
            self.assertEqual([row['status'] for row in result], ['failed', 'saved'])
            self.assertFalse((output / '0121.mp4').exists())
            self.assertTrue((output / '0156.mp4').is_file())

    def test_missing_hls_segment_does_not_leave_a_truncated_video_marked_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            result = downloader.download_video({'order': 121, 'type': 'STREAM', 'url': self.origin + '/broken/media.m3u8'},
                                               folder, self.origin + '/product', 20)
            self.assertEqual(result['status'], 'failed')
            self.assertFalse((folder / '0121.mp4').exists())
            self.assertFalse((folder / '0121.partial.mp4').exists())
