"""Download media-grab JSON manifests or one-URL-per-line text files.

Python 3.10+, standard library only. Original response bytes are preserved.
This is a URL downloader; it does not import browser cookies or join streams.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import csv
import datetime as dt
import http.client
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


def load_manifest(path: Path) -> tuple[list[dict], str]:
    text = path.read_text(encoding="utf-8-sig").strip()
    page_url = ""
    if text.startswith(("{", "[")):
        document = json.loads(text)
        if isinstance(document, dict):
            page_url = str(document.get("pageUrl") or "")
            items = document.get("items")
        else:
            items = document
        if not isinstance(items, list):
            raise ValueError("JSON에 items 배열이 없습니다. mediaGrab.export()로 다시 저장하세요.")
    else:
        items = [line.strip() for line in text.splitlines()
                 if line.strip() and not line.lstrip().startswith("#")]
    jobs, seen = [], set()
    for item in items:
        item = {"url": item} if isinstance(item, str) else item
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            raise ValueError("목록에 URL 문자열이 아닌 항목이 있습니다.")
        url = item["url"].strip()
        if not url or url in seen:
            continue
        seen.add(url)
        jobs.append({"order": len(jobs) + 1, "url": url,
                     "type": str(item.get("type") or "")})
    if not jobs:
        raise ValueError("다운로드할 주소가 없습니다.")
    return jobs, page_url


def origin_referer(page_url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(page_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return ""
        if parsed.username or parsed.password:
            return ""
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
    except ValueError:
        return ""


def detect_extension(prefix: bytes) -> str | None:
    """Recognize common media headers; a .gif URL or MIME alone is insufficient."""
    if prefix.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if prefix.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if prefix[:4] == b"RIFF" and prefix[8:12] == b"WEBP":
        return ".webp"
    if prefix[:4] == b"RIFF" and prefix[8:12] == b"AVI ":
        return ".avi"
    if prefix.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")):
        return ".tiff"
    if prefix.startswith(b"BM") and len(prefix) >= 14:
        return ".bmp"
    if prefix.startswith(b"\x00\x00\x01\x00") and len(prefix) >= 6:
        return ".ico"
    if prefix[4:8] == b"ftyp":
        brands = {prefix[i:i + 4] for i in [8, *range(16, min(len(prefix), 128), 4)]}
        if brands & {b"avif", b"avis"}:
            return ".avif"
        if brands & {b"heic", b"heix", b"hevc", b"hevx"}:
            return ".heic"
        if brands & {b"mif1", b"msf1"}:
            return ".heif"
        return ".mov" if b"qt  " in brands else ".mp4"
    if prefix.startswith(b"\x1aE\xdf\xa3"):
        return ".webm" if b"webm" in prefix[:4096].lower() else ".mkv"
    if prefix.startswith(b"OggS"):
        return ".ogv"
    if prefix.startswith((b"\x00\x00\x01\xba", b"\x00\x00\x01\xb3")):
        return ".mpeg"
    text = prefix.decode("utf-8-sig", errors="replace").lstrip()
    if text.startswith("#EXTM3U"):
        return ".m3u8"
    text = re.sub(r"^<\?xml\b.*?\?>\s*", "", text, flags=re.DOTALL)
    while text.startswith("<!--") and "-->" in text:
        text = text.split("-->", 1)[1].lstrip()
    text = re.sub(r"^<!DOCTYPE\s+svg\b[^>]*>\s*", "", text, flags=re.IGNORECASE)
    if re.match(r"<svg(?:\s|>)", text):
        return ".svg"
    if re.match(r"<(?:[\w.-]+:)?MPD(?:\s|>)", text):
        return ".mpd"
    return None


def decode_data_url(url: str) -> tuple[bytes, str]:
    header, separator, payload = url[5:].partition(",")
    if not separator:
        raise ValueError("잘못된 data 주소입니다.")
    content_type = header.split(";", 1)[0].lower() or "text/plain"
    if not content_type.startswith(("image/", "video/")):
        raise ValueError("이미지·영상이 아닌 data 주소입니다.")
    data = urllib.parse.unquote_to_bytes(payload)
    if "base64" in header.lower().split(";"):
        data = re.sub(rb"\s+", b"", data)
        data = base64.b64decode(data + b"=" * (-len(data) % 4), validate=True)
    return data, content_type


def download_one(job: dict, folder: Path, width: int, referer: str, timeout: float) -> dict:
    result = {**job, "status": "failed", "filename": "", "bytes": 0,
              "http_status": "", "content_type": "", "message": ""}
    temporary = None
    try:
        parsed = urllib.parse.urlsplit(job["url"])
        if parsed.scheme == "blob":
            result.update(status="skipped", message="blob 주소는 현재 브라우저 세션 안에서만 접근할 수 있습니다.")
            return result
        if parsed.scheme not in ("http", "https", "data"):
            result.update(status="skipped", message="지원하는 주소는 http, https, data입니다.")
            return result
        if parsed.hostname == "mercury.coupang.com" and parsed.path == "/e.gif":
            result.update(status="skipped", message="통계·이벤트 요청 주소입니다.")
            return result
        if parsed.username or parsed.password:
            raise ValueError("계정 정보가 포함된 주소는 지원하지 않습니다.")
        handle = tempfile.NamedTemporaryFile(prefix=".media-", suffix=".part", dir=folder, delete=False)
        temporary = Path(handle.name)
        with handle:
            if parsed.scheme == "data":
                data, result["content_type"] = decode_data_url(job["url"])
                handle.write(data)
            else:
                headers = {"User-Agent": "ScraperMediaDownloader/1.0", "Accept": "*/*", "Accept-Encoding": "identity"}
                if referer:
                    headers["Referer"] = referer
                request = urllib.request.Request(job["url"], headers=headers)
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    result["http_status"] = response.status
                    result["content_type"] = response.headers.get("Content-Type", "")
                    received = 0
                    while chunk := response.read(64 * 1024):
                        handle.write(chunk)
                        received += len(chunk)
                    length = response.headers.get("Content-Length", "")
                    if length.isdigit() and received != int(length):
                        raise ValueError("응답이 중간에 끊겼습니다. 파일을 완전히 받지 못했습니다.")
        with temporary.open("rb") as source:
            extension = detect_extension(source.read(16 * 1024))
        if extension is None:
            raise ValueError("응답이 지원하는 미디어 형식이 아닙니다. OK·HTML·JSON 또는 손상된 파일일 수 있습니다.")
        filename = f"{job['order']:0{width}d}{extension}"
        os.replace(temporary, folder / filename)
        temporary = None
        result.update(status="playlist" if extension in (".m3u8", ".mpd") else "saved",
                      filename=filename, bytes=(folder / filename).stat().st_size)
        if result["status"] == "playlist":
            result["message"] = "재생목록만 저장했습니다. 완성된 동영상 파일로 합치지는 않습니다."
    except urllib.error.HTTPError as error:
        result["http_status"] = error.code
        result["message"] = f"HTTP {error.code}: {error.reason}"
        error.close()
        if "…" in urllib.parse.unquote(job["url"]):
            result["message"] += " / 주소에 생략 기호가 있습니다. 목록을 다시 내보내세요."
    except (OSError, ValueError, http.client.HTTPException) as error:
        result["message"] = str(error)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return result


def write_reports(folder: Path, results: list[dict]) -> None:
    fields = ["order", "status", "filename", "bytes", "http_status", "content_type", "url", "message"]
    for name, rows in [("download-report.csv", results),
                       ("failed.csv", [row for row in results if row["status"] in ("failed", "skipped")])]:
        with (folder / name).open("w", encoding="utf-8-sig", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
    (folder / "download-report.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="수집한 주소를 원본 파일로 일괄 다운로드합니다. Python 3.10+ 필요.")
    parser.add_argument("manifest", type=Path, help="media-manifest.json 또는 한 줄에 URL 하나인 텍스트 파일")
    parser.add_argument("--output", type=Path, help="새로 만들 결과 폴더. 이미 존재하는 폴더에는 저장하지 않습니다.")
    parser.add_argument("--workers", type=int, default=4, help="동시 다운로드 수, 1~16 (기본 4)")
    parser.add_argument("--timeout", type=float, default=20, help="연결·읽기 대기 제한(초), 기본 20")
    args = parser.parse_args(argv)
    if not 1 <= args.workers <= 16 or args.timeout <= 0:
        parser.error("workers는 1~16, timeout은 0보다 커야 합니다.")
    try:
        manifest = args.manifest.resolve()
        jobs, page_url = load_manifest(manifest)
        batch = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        folder = args.output.resolve() if args.output else manifest.parent / "download-output" / batch
        folder.mkdir(parents=True, exist_ok=False)
    except (OSError, ValueError) as error:
        print(f"시작 실패: {error}", file=sys.stderr)
        return 1
    width, results = max(4, len(str(len(jobs)))), []
    print(f"총 {len(jobs)}개 / 동시 {args.workers}개 / 저장 폴더: {folder}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(download_one, job, folder, width, origin_referer(page_url), args.timeout)
                   for job in jobs]
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            result = future.result()
            results.append(result)
            print(f"[{completed}/{len(jobs)}] #{result['order']:0{width}d} {result['status']} "
                  f"{result['filename'] or result['message']}", flush=True)
    results.sort(key=lambda row: row["order"])
    write_reports(folder, results)
    saved = sum(row["status"] == "saved" for row in results)
    playlists = sum(row["status"] == "playlist" for row in results)
    unsuccessful = len(results) - saved - playlists
    print(f"완료: 파일 {saved}개 / 재생목록 {playlists}개 / 실패·건너뜀 {unsuccessful}개")
    print(f"실패 기록: {folder / 'failed.csv'}")
    return 2 if unsuccessful else 0


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        print("Python 3.10 이상을 설치하세요: https://www.python.org/downloads/windows/", file=sys.stderr)
        sys.exit(1)
    sys.exit(main())
