# Amazon CAROTE CDP 다운로드 재검증 — 2026-10-18

- 페이지: https://www.amazon.com/CAROTE-Cookware-Detachable-Induction-Dishwasher/dp/B0F7M3LVN8
- 원본: `main` 커밋 `42f926a552bc383b89029683858f1bb888e3785f`, 수집기 `2026.10.17.1`
- 수정본: 수집기 `2026.10.18.1`, 코드 커밋 `fea74ff4b3ce74f2f97e0c528d456adc6bb7fba0`
- 검증한 수정 코드 Git blob SHA-1: `37ba6f86a84bf006a30d5597ce8796f85bcba417`
- 수정본 다운로드 처리: 2026-10-18 14:34:21–14:34:40 KST

사용자가 열어둔 Chrome 상품 탭에서 CDP `Runtime.evaluate`로 저장소 원문을 실행했다. 실행 전 원문의 UTF-8 바이트와 Git blob 헤더를 SHA-1으로 계산해 저장소의 blob SHA와 대조했다. 원본과 수정본 모두 기본 `await mediaGrab.download()`를 실행했다.

## 원본에서 확인한 문제와 변경

원본은 347개 주소 중 미디어 344개를 저장하고, 임시 영상 주소 2개를 실제 저장 원본에 연결했으며, 숨겨진 광고 포스터 1개를 읽지 못했다. ZIP 바이트의 CRC·파일명·크기 불일치는 없었다. 표시 이미지 71개와 영상 카드 20개도 저장 원본과 연결됐다.

그러나 첫 번째와 두 번째 ZIP의 `page-audit.json`은 `finished:false`였으며, 각각 62개와 30개를 미저장으로 표시했다. 마지막 ZIP의 최종 실패는 1개였다. 이는 앞쪽 ZIP에 다운로드 도중의 감사 결과가 고정되는 문제였다.

수정본은 미디어를 ZIP 크기 한도에 따라 나누되, 모든 주소의 처리가 끝난 뒤 각 ZIP에 같은 최종 감사 결과를 넣고 저장한다. `download-report.json`은 해당 ZIP의 파일 목록과 함께 전체 결과 개수·완료 시각·분할 번호를 `session`에 담는다.

추가로 `data-a-hires`·`data-hires`·`data-img` 이미지 주소와 변경 감시를 보강했다. 이 페이지의 해당 속성에는 이미 다른 경로로 수집된 주소만 있었으므로, 실제 이미지 누락을 새로 해결했다고 주장하지 않는다. 영상 탭에서 카드가 로딩되지 않는 경우 경고를 남기고, 미완료·실패한 영상 목록 응답도 완전성 판단에 반영한다. `mediaGrab.audit()`와 다운로드 감사에서 접근 불가 iframe을 같은 방식으로 전달한다.

## 수정본 결과

| 항목 | 결과 |
|---|---:|
| 관찰 URL | 343 |
| 실제 ZIP 미디어 파일 | 340 |
| 저장 원본으로 연결된 임시 영상 주소 | 2 |
| 실제 읽기 실패 | 1 |
| 수집기 표시 URL / 저장 누락 | 87 / 0 |
| 독립 점검의 표시 이미지 요소 / 고유 선택 URL | 71 / 62 |
| 독립 점검의 CSS 이미지 고유 URL | 12 |
| 독립 점검의 표시 URL 합계 / 저장 누락 | 79 / 0 |
| 독립 점검의 표시 인라인 SVG 요소 / 도형 대응 누락 | 3 / 0 |
| 상품 영상 카드 / 원본 저장 누락 | 10 / 0 |
| 관련 영상 카드 / 원본 저장 누락 | 10 / 0 |
| 두 목록의 고유 영상 카드 | 18 — 공통 카드 2개 |
| 미확인 영상 썸네일 / 응답 대기 / 수집 오류 | 0 / 0 / 0 |
| 준비 경고 / 처리 한도 도달 | 0 / 0 |

독립 점검은 수집기의 `visibleRows`를 재사용하지 않고 DOM의 렌더링·조상 overflow 잘림, 선택된 이미지 주소, CSS·의사 요소 이미지, 영상 포스터·현재 재생 주소를 확인했다. 카드의 실제 `data-video-url`을 저장 결과와 대조했다. 표시 인라인 SVG는 내보낸 SVG의 viewBox와 벡터 도형 속성에 대응시켰다. 독립 점검의 79개는 고유 표시 URL이며, 별도로 비교한 인라인 SVG와 갤러리 카드 수를 합산한 값이 아니다. 표시 canvas는 없었다.

원본과 수정본의 URL 수 차이는 숨겨진 PNG 스프라이트 1개, 과거 네트워크의 저해상도 HLS 주소 1개, 임시 인라인 SVG 표현 2개였다. 이 네 주소는 원본 대조 시점에도 `visible:false`였다. 해당 영상의 실제 마스터 HLS 두 주소는 수정본에서도 각각 MP4로 저장됐다. 페이지 로딩 상태가 달라지므로 총 파일 수만으로 누락을 판정하지 않았다.

## ZIP 바이트와 미디어 검증

| ZIP | 바이트 | 미디어 파일 | 전체 엔트리 |
|---|---:|---:|---:|
| `page-media-20261018T053421-001.zip` | 266,820,864 | 283 | 288 |
| `page-media-20261018T053421-002.zip` | 233,653,349 | 56 | 61 |
| `page-media-20261018T053421-003.zip` | 42,585,539 | 1 | 6 |
| 합계 | 543,059,752 | 340 | 355 |

- 독립적인 ZIP 중앙 디렉터리·로컬 헤더 판독과 전체 엔트리 CRC-32 재계산: 오류 0건.
- 저장 결과의 파일명·바이트 수와 ZIP 실제 엔트리 대조: 불일치·누락 0건.
- 모든 ZIP의 `page-audit.json`과 최종 `mediaGrab.lastDownload.audit`: 동일.
- 래스터 이미지 290개: 브라우저 이미지 디코딩 성공. JPG 257개, PNG 25개, WebP 1개, GIF 7개다.
- SVG 24개: XML 파싱 오류 0건.
- GIF 7개: 실제 원본 URL을 다시 읽어 ZIP 바이트와 SHA-256 대조, 모두 일치.
- 애니메이션 4개: ImageDecoder에서 프레임 수 18·18·8·72를 확인하고 각 마지막 프레임 디코딩 성공.
- MP4 26개: 유효한 해상도·재생 시간 확인 및 처음·끝 부근 2프레임씩 디코딩 성공.

영상의 모든 프레임·음성 샘플을 원본과 비교한 검사는 아니다. 일부 HLS의 재생목록 합산 시간과 MP4 시간에는 1초 미만의 차이가 있으나, 이번에는 전 샘플 지문 대조까지 수행하지 않았다. 다운로드·CRC·경계 프레임 검사의 통과 범위와 구분한다.

## 남은 실패와 확인 범위

실패 1개는 `d1f0esyb34c1g2.cloudfront.net`의 광고 영상 포스터다. 현재 DOM의 표시 미디어에 대응하지 않는 과거 관찰 주소이며, 두 실행에서 모두 `visible:false`였다. 해당 URL만 다시 요청해 CDP 네트워크 이벤트를 확인한 결과 `net::ERR_FAILED`, CORS 사유 `MissingAllowOriginHeader`였다. 다른 이미지로 대체하거나 성공으로 바꾸지 않았다.

```js
mediaGrab.lastDownload.audit.completeForVisibleUrls   // true
mediaGrab.lastDownload.audit.completeForObservedUrls  // false
mediaGrab.lastDownload.audit.completeForLoadedPage    // false
```

첫 필드는 현재 관찰한 표시 URL의 대조 결과다. 두 번째는 위 실패 때문에 거짓이며, 세 번째는 실패 및 접근할 수 없는 `s.amazon-adsystem.com` iframe 때문에 거짓이다. 미관찰 콘텐츠·다른 상품 옵션·열지 않은 목록·DRM·접근 불가 하위 문서까지 전부 수집했다고 주장하지 않는다.

세 ZIP 모두 브라우저에 저장 요청을 발행했다. 이번 무결성·미디어 검증은 그 저장 요청에 사용한 동일한 Blob 페이로드의 바이트를 대상으로 했다. 운영체제 다운로드 폴더의 파일을 다시 연 검사는 아니므로 디스크 저장 완료까지 확인한 것으로 해석하면 안 된다. 최종 ZIP은 `mediaGrab.lastDownload.archives`에 남아 있고, 필요하면 `mediaGrab.saveArchive(1)` 등의 명령으로 저장을 다시 요청할 수 있다.

갤러리 준비 중 Amazon 페이지의 자동 재생 시도가 사용자 상호작용 부족으로 거부되는 `NotAllowedError` 4건도 관찰했다. 파일 수집·검증 실패와 구분했다. CDP 이벤트 버퍼 일부가 잘렸으므로 전체 실행의 처리되지 않은 예외가 0건이라고 주장하지 않는다.

## 회귀 검사

- Node v24.21.0에서 구문 검사와 `git diff --check` 통과.
- Node 테스트 104개 통과, 실패 0개. FFmpeg/FFprobe 의존 기존 검사 7개는 도구 부재로 건너뜀.
- 로컬 HTTP 서버가 필요한 기존 검사 6개는 실행 환경의 `listen EPERM` 제한 때문에 제외했다. 처음 실행에서 이를 확인했으며 코드 결함에 의한 실패로 집계하지 않는다.
- 새 회귀 검사 7개: 분할 ZIP 최종 감사 일치, 숨겨진 실패와 표시 URL의 구분, iframe 완전성, 목록 응답 실패·대기, 고해상도 속성과 변경 감시, 빈 영상 탭 경고.

```sh
node --check collect-page-media.js
node --test --test-isolation=none \
  --test-skip-pattern='real HTTP|encrypted, live|HLS cycle|aborted HLS|HLS metadata' \
  tests/media-order.test.cjs tests/hls-download.test.cjs tests/zip-download.test.cjs
```

일반 개발 환경에서는 필터 없이 기존 HTTP 통합 검사도 실행해야 한다. 현재 Chrome 탭에는 수정본 `mediaGrab`, 최종 `lastDownload`와 자동 감시가 남아 있다.
