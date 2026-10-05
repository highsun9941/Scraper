"""Download collected VIDEO/STREAM/EMBED entries using an optional yt-dlp install.

Images and unresolved review thumbnails are never turned into guessed video URLs.
No browser cookies, page JavaScript or shell command strings are executed here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.parse
import uuid


def load_videos(path: Path) -> tuple[list[dict], str, int]:
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    items = document.get("items") if isinstance(document, dict) else document
    if not isinstance(items, list):
        raise ValueError("mediaGrab.export()로 내보낸 JSON 목록이 필요합니다.")
    jobs, seen, orders = [], set(), set()
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ValueError("각 항목에 type과 url이 있어야 합니다.")
        if item.get("type") not in ("VIDEO", "STREAM", "EMBED"):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ValueError("영상 주소가 없는 항목이 있습니다.")
        url = url.strip()
        if url in seen:
            continue
        order = item.get("order", index)
        if isinstance(order, bool) or not isinstance(order, int) or not 1 <= order <= 100000000 or order in orders:
            raise ValueError("영상 순번은 서로 다른 양의 정수여야 합니다.")
        seen.add(url); orders.add(order)
        jobs.append({"order": order, "type": item["type"], "url": url})
    page_url = str(document.get("pageUrl") or "") if isinstance(document, dict) else ""
    pending = document.get("pendingVideos") if isinstance(document, dict) else []
    return jobs, page_url, len(pending) if isinstance(pending, list) else 0


def download_video(job: dict, folder: Path, page_url: str, timeout: float) -> dict:
    result = {**job, "status": "failed", "filename": "", "bytes": 0, "message": ""}
    try:
        parsed = urllib.parse.urlsplit(job["url"])
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            result.update(status="skipped", message="blob 대신 원본 http·https 영상 주소가 필요합니다.")
            return result
        if parsed.username or parsed.password or any(c in job["url"] for c in "\r\n"):
            raise ValueError("계정 정보 또는 줄바꿈이 포함된 주소는 지원하지 않습니다.")
        # Escape literal % in folder names, leaving only our extension placeholder.
        template = str(folder).replace("%", "%%") + f"/{job['order']:04d}.%(ext)s"
        command = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
                   "--no-progress", "--no-overwrites", "--socket-timeout", "30",
                   "--retries", "2", "--fragment-retries", "2", "--output", template,
                   "--format", "b[ext=mp4]/b", "--print", "after_move:filepath"]
        if shutil.which("node"):
            command += ["--js-runtimes", "node"]
        page = urllib.parse.urlsplit(page_url)
        if ("youtube" not in parsed.hostname and parsed.hostname != "youtu.be" and
                page.scheme in ("http", "https") and page.hostname and not page.username and not page.password):
            command += ["--referer", urllib.parse.urlunsplit((page.scheme, page.netloc, "/", "", ""))]
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
    parser = argparse.ArgumentParser(description="수집 목록에서 영상만 yt-dlp로 다운로드합니다. Python 3.10+ 및 yt-dlp 필요.")
    parser.add_argument("manifest", type=Path, help="mediaGrab.export()로 저장한 media-manifest.json")
    parser.add_argument("--output", type=Path, help="새 결과 폴더. 이미 존재하는 폴더는 사용하지 않습니다.")
    parser.add_argument("--timeout", type=float, default=600, help="영상 한 개의 전체 시간 제한(초), 기본 600")
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 86400:
        parser.error("timeout은 0 초과~86400이어야 합니다.")
    try:
        jobs, page_url, pending = load_videos(args.manifest)
        if pending:
            print(f"주의: 아직 썸네일만 확인된 리뷰 영상 {pending}개가 있습니다. 재생 후 목록을 다시 내보내세요.")
        if not jobs:
            print("영상 주소가 없습니다. 최신 수집 코드를 실행하고 리뷰 영상을 재생한 뒤 mediaGrab.export() 하세요.")
            return 1
        if importlib.util.find_spec("yt_dlp") is None:
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
        result = download_video(job, folder, page_url, args.timeout)
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
