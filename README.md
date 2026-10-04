# System_V3

F.v1 피킹 시스템, Sellpia 스크래퍼, Sellpia 메모 업데이터 통합 배포 repo입니다.

- 시스템 본체: https://w-works-official.github.io/Operation_Hub/
- 스크래퍼: https://w-works-official.github.io/Operation_Hub/tools/sellpia_scraper.html
- 업데이터: https://w-works-official.github.io/Operation_Hub/tools/sellpia_memo_updater_0707_stockmatch.html

## F.v1 모드

- 기본 접속: read-only
- `?write=0&events=0`: read-only 명시
- `?write=1`: 일반 write 허용, workflow event write OFF
- `?write=1&events=1`: workflow event write 허용

공개 repo이므로 service_role key, 운영 데이터, 임시 백업 파일을 포함하지 않습니다.
