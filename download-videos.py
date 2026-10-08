"""Download collected videos or videos found in JSON/CSV download reports.

Images and unresolved review thumbnails are never turned into guessed video URLs.
FFmpeg joins STREAM fragments into MP4; yt-dlp handles VIDEO/EMBED entries.
No browser cookies, page JavaScript or shell command strings are executed here.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import uuid


def report_kind(item: dict) -> str:
    declared = item.get("type")
    if declared:
        return declared if declared in ("VIDEO", "STREAM", "EMBED") else ""
    url = item.get("url")
    if not isinstance(url, str):
        return ""
    parsed = urllib.parse.urlsplit(url)
    extension = Path(parsed.path).suffix.lower()
    mime = str(item.get("content_type") or item.get("contentType") or "").split(";", 1)[0].strip().lower()
    if extension in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg") or mime.startswith("image/"):
        return ""
    if extension in (".m3u8", ".mpd") or mime in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml", "audio/mpegurl", "audio/x-mpegurl"):
        return "STREAM"
    if extension in (".mp4", ".webm", ".m4v", ".mov", ".ogv", ".avi", ".mkv", ".mpg", ".mpeg") or mime.startswith("video/"):
        return "VIDEO"
    if parsed.hostname in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"):
        return "EMBED"
    return ""


def load_videos(path: Path) -> tuple[list[dict], str, int]:
    text = path.read_text(encoding="utf-8-sig")
    document = list(csv.DictReader(io.StringIO(text))) if path.suffix.lower() == ".csv" else json.loads(text)
    items = document.get("items", document.get("results")) if isinstance(document, dict) else document
    if not isinstance(items, list):
        raise ValueError("media-manifest.json 또는 download-report.json·CSV의 목록이 필요합니다.")
    jobs, seen, orders = [], set(), set()
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ValueError("각 항목은 영상 주소를 포함하는 객체여야 합니다.")
        kind = report_kind(item)
        if not kind:
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ValueError("영상 주소가 없는 항목이 있습니다.")
        url = url.strip()
        if url in seen:
            continue
        order = item.get("order", index)
        if isinstance(order, str) and order.isascii() and order.isdecimal():
            order = int(order)
        if isinstance(order, bool) or not isinstance(order, int) or not 1 <= order <= 100000000 or order in orders:
            raise ValueError("영상 순번은 서로 다른 양의 정수여야 합니다.")
        seen.add(url); orders.add(order)
        jobs.append({"order": order, "type": kind, "url": url})
    page_url = str(document.get("pageUrl") or "") if isinstance(document, dict) else ""
    pending = document.get("pendingVideos") if isinstance(document, dict) else []
    return jobs, page_url, len(pending) if isinstance(pending, list) else 0


def media_tools(location: Path | None = None) -> tuple[str, str]:
    root = location or Path(__file__).resolve().parent
    root = root.parent if root.is_file() else root
    def find(name: str) -> str | None:
        for candidate in (root / (name + ".exe"), root / name, root / "bin" / (name + ".exe"), root / "bin" / name):
            if candidate.is_file():
                return str(candidate.resolve())
        return shutil.which(name) if location is None else None
    ffmpeg, ffprobe = find("ffmpeg"), find("ffprobe")
    if not ffmpeg or not ffprobe:
        raise ValueError("HLS·DASH 영상을 MP4로 저장하려면 ffmpeg와 ffprobe가 필요합니다. 두 실행 파일을 이 스크립트와 같은 폴더에 두거나 --ffmpeg-location으로 폴더를 지정하세요. https://ffmpeg.org/download.html")
    return ffmpeg, ffprobe


def stream_mp4(job: dict, folder: Path, referer: str, timeout: float, location: Path | None) -> dict:
    ffmpeg, ffprobe = media_tools(location)
    output = folder / f"{job['order']:04d}.mp4"
    partial = folder / f"{job['order']:04d}.partial.mp4"
    if output.exists() or partial.exists():
        raise ValueError("영상 파일이 이미 있습니다. 새 결과 폴더를 사용하세요.")
    command = [ffmpeg, "-hide_banner", "-loglevel", "level+warning", "-xerror", "-nostdin", "-n",
               "-rw_timeout", str(max(1, int(min(30, timeout) * 1000000))),
               "-protocol_whitelist", "http,https,httpproxy,tcp,tls,crypto", "-user_agent", "Mozilla/5.0"]
    if referer:
        command += ["-referer", referer]
    command += ["-i", job["url"], "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
                "-movflags", "+faststart", str(partial)]
    started = time.monotonic()
    try:
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout, check=False)
        # HLS는 누락된 조각을 warning만 남기고 건너뛴 뒤 exit 0을 반환할 수도 있습니다.
        stream_error = re.search(r"\[(?:error|fatal|panic)\]|HTTP error [45]\d{2}|Stream ends prematurely|"
                                 r"(?:failed|unable|error).*?(?:segment|fragment|key)|(?:segment|fragment|key).*?(?:failed|skipp)",
                                 completed.stderr, re.IGNORECASE)
        if completed.returncode or stream_error:
            raise ValueError((completed.stderr.strip() or f"FFmpeg 종료 코드 {completed.returncode}")[-4000:])
        if not partial.is_file() or partial.stat().st_size == 0:
            raise ValueError("FFmpeg가 완료됐지만 MP4 파일을 확인하지 못했습니다.")
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command, timeout)
        probe = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                                "format=duration,format_name:stream=codec_type,codec_name,width,height", "-of", "json", str(partial)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=remaining, check=False)
        if probe.returncode or probe.stderr.strip():
            raise ValueError("MP4 검사 실패: " + probe.stderr.strip()[-2000:])
        info = json.loads(probe.stdout)
        video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
        duration = float(info.get("format", {}).get("duration", 0))
        if not video or not math.isfinite(duration) or duration <= 0 or "mp4" not in info.get("format", {}).get("format_name", ""):
            raise ValueError("완성된 MP4의 영상 스트림·재생 시간을 확인하지 못했습니다.")
        if output.exists():
            raise ValueError("최종 영상 파일이 이미 있습니다.")
        partial.rename(output)
        return {"filename": output.name, "bytes": output.stat().st_size, "duration_seconds": round(duration, 3),
                "width": video.get("width"), "height": video.get("height"), "video_codec": video.get("codec_name"),
                "has_audio": any(s.get("codec_type") == "audio" for s in info.get("streams", [])),
                "message": "영상 조각을 받아 MP4로 합쳤습니다. 원본 코덱을 유지하며 재인코딩하지 않습니다."}
    finally:
        partial.unlink(missing_ok=True)


def download_video(job: dict, folder: Path, page_url: str, timeout: float, ffmpeg_location: Path | None = None) -> dict:
    result = {**job, "status": "failed", "filename": "", "bytes": 0, "message": ""}
    try:
        parsed = urllib.parse.urlsplit(job["url"])
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            result.update(status="skipped", message="blob 대신 원본 http·https 영상 주소가 필요합니다.")
            return result
        if parsed.username or parsed.password or any(c in job["url"] for c in "\r\n"):
            raise ValueError("계정 정보 또는 줄바꿈이 포함된 주소는 지원하지 않습니다.")
        page = urllib.parse.urlsplit(page_url)
        referer = urllib.parse.urlunsplit((page.scheme, page.netloc, "/", "", "")) if (
            page.scheme in ("http", "https") and page.hostname and not page.username and not page.password and
            not any(c in page_url for c in "\r\n")) else ""
        if job["type"] == "STREAM":
            result.update(stream_mp4(job, folder, referer, timeout, ffmpeg_location), status="saved")
            return result
        # Escape literal % in folder names, leaving only our extension placeholder.
        template = str(folder).replace("%", "%%") + f"/{job['order']:04d}.%(ext)s"
        command = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
                   "--no-progress", "--no-overwrites", "--socket-timeout", "30",
                   "--retries", "2", "--fragment-retries", "2", "--output", template,
                   "--format", "b[ext=mp4]/b/bv[ext=mp4]/bv", "--print", "after_move:filepath"]
        if ffmpeg_location:
            command += ["--ffmpeg-location", str(ffmpeg_location)]
        if shutil.which("node"):
            command += ["--js-runtimes", "node"]
        if "youtube" not in parsed.hostname and parsed.hostname != "youtu.be" and referer:
            command += ["--referer", referer]
        command += ["--", job["url"]]
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout, check=False)
        if completed.returncode:
            raise ValueError((completed.stderr.strip() or completed.stdout.strip() or
                              f"yt-dlp 종료 코드 {completed.returncode}")[-4000:])
        files = [Path(line.strip()).resolve() for line in completed.stdout.splitlines() if line.strip()]
        root = folder.resolve()
        files = [path for path in files if path.parent == root and path.is_file() and
                 path.stem == f"{job['order']:04d}" and path.suffix not in (".part", ".ytdl") and path.stat().st_size > 0]
        if not files:
            raise ValueError("yt-dlp가 완료됐지만 최종 영상 파일을 확인하지 못했습니다.")
        file = files[-1]
        result.update(status="saved", filename=file.name, bytes=file.stat().st_size)
    except subprocess.TimeoutExpired:
        result["message"] = "영상 다운로드 시간 제한을 넘었습니다. --timeout으로 제한을 조절하세요."
    except (OSError, ValueError) as error:
        result["message"] = str(error)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="수집 목록·다운로드 보고서에서 영상을 저장합니다. STREAM은 FFmpeg로 MP4 병합, VIDEO·EMBED는 yt-dlp 사용. Python 3.10+ 필요.")
    parser.add_argument("manifest", type=Path, help="media-manifest.json 또는 download-report.json·CSV")
    parser.add_argument("--output", type=Path, help="새 결과 폴더. 이미 존재하는 폴더는 사용하지 않습니다.")
    parser.add_argument("--timeout", type=float, default=600, help="영상 한 개의 전체 시간 제한(초), 기본 600")
    parser.add_argument("--ffmpeg-location", type=Path, help="ffmpeg와 ffprobe가 있는 폴더 또는 ffmpeg 실행 파일 경로")
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 86400:
        parser.error("timeout은 0 초과~86400이어야 합니다.")
    try:
        jobs, page_url, pending = load_videos(args.manifest)
        if pending:
            print(f"원본 주소를 확인하지 못한 리뷰 영상 {pending}개가 있습니다. mediaGrab.collectReviewVideos() 결과를 확인하세요.")
        if not jobs:
            print("영상 주소가 없습니다. 최신 수집 코드에서 await mediaGrab.collectReviewVideos() 후 mediaGrab.export() 하세요.")
            return 1
        if all(job["type"] == "STREAM" for job in jobs):
            media_tools(args.ffmpeg_location)
        elif not any(job["type"] == "STREAM" for job in jobs) and importlib.util.find_spec("yt_dlp") is None:
            print('yt-dlp를 설치하세요: python -m pip install -U "yt-dlp[default]"', file=sys.stderr)
            return 1
        batch = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        folder = args.output.resolve() if args.output else args.manifest.resolve().parent / "video-output" / batch
        folder.mkdir(parents=True, exist_ok=False)
    except (OSError, ValueError) as error:
        print(f"시작 실패: {error}", file=sys.stderr)
        return 1
    print(f"영상 {len(jobs)}개 / 저장 폴더: {folder}")
    results = []
    for index, job in enumerate(jobs, 1):
        print(f"[{index}/{len(jobs)}] #{job['order']:04d} {job['type']} 다운로드 시작", flush=True)
        result = download_video(job, folder, page_url, args.timeout, args.ffmpeg_location)
        results.append(result)
        print(result["filename"] or result["message"], flush=True)
        (folder / "video-report.json").write_text(
            json.dumps({"pageUrl": page_url, "pendingVideoCount": pending, "results": results},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    saved = sum(row["status"] == "saved" for row in results)
    print(f"완료: 영상 {saved}개 / 실패·건너뜀 {len(results) - saved}개 / 미확인 리뷰 영상 {pending}개")
    return 0 if saved == len(results) and not pending else 2


if __name__ == "__main__":
    sys.exit(main())
