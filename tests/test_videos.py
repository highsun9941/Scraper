"""Video download orchestration tests; these do not contact YouTube or Coupang."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
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
