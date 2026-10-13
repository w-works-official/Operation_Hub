# Sellpia 공식 원본 수집기

회사 PC가 Hub의 수집 요청을 outbound HTTPS로 받아 셀피아 공식 화면의 분할 원본을 수집합니다. 이 도구는 `uploadSellpiaSnapshot`이나 운영 snapshot RPC를 호출하지 않습니다. 운영 반영은 Hub의 기존 검증·업로드 경계에서 별도로 수행합니다.

## 현재 준비 상태

`config.example.json`의 `verifiedReady`는 **false**를 유지합니다. 확인된 공식 Grid UI는 버튼 한 번으로 10,000개씩 원본 CSV를 자동 분할하여 내려받습니다. 실제 파일은 10,000/10,000/7,278행, 필수 24개를 포함한 62개 헤더로 검증되었고, 회사 PC의 독립 Edge persistent profile에서도 runner CLI 수집을 같은 headed context에서 두 번 연속 완료했습니다. 검증한 회사 PC의 Git 밖 로컬 설정만 활성화하며, 다른 PC에서는 해당 환경의 계약과 인증을 확인해야 합니다. 파일 하나를 인위적으로 3개로 나누는 기능은 없습니다.

2026-10-13 실제 CLI `collect --login --repeat 2` 실행 결과(Asia/Seoul):

| 실행 | 완료 시각 | 작업 ID | 결과 |
| --- | --- | --- | --- |
| 1 | 15:35:54 | `17b1c396-651a-4b0a-962e-f88d51f2c3bd` | `collected`, 원본 3개, 27,278행 |
| 2 | 15:36:14 | `804883ac-0600-4ea6-89c7-24d69e37995e` | `collected`, 원본 3개, 27,278행 |

CLI 종료 코드는 0이었고, 각 실행은 새 UUID와 새 전체조회로 수집했습니다. 이것은 독립 로컬 수집과 같은 context 반복 성공의 증거입니다. 회사 PC 재시작·장시간 인증 유지·실제 클라우드 큐/Storage·Hub 운영 반영은 이 실행에서 검증하지 않았습니다.

상단 상품 전체 다운로드의 단일 파일은 행번호·가용재고·매입처 부가세 등 Hub 필수 원본 필드가 없어 사용하지 않습니다. Grid의 `title="출력"` 버튼은 PRINT 기능이므로 사용하지 않습니다. runner는 실제로 확인된 `span[title="CSV"]`와 `그리드 다운로드 v1.1.14` dialog만 이용합니다.

확인된 화면 계약:

- `https://curiouswiz.sellpia.com/product_list_total.html`
- `#search_type` 값 `8`(전체)을 선택한 직후 경고의 `Ok`를 확인하고, 그 뒤 검색 버튼을 누름.
- `#search_key`·`#txt_search` 비움, 판매구분·분류·상품구분 전체 선택, 그룹·선택행 제한 해제, 품절·단종 포함.
- `.loading-indicator2`가 새 조회에서 visible로 바뀌었다가 hidden이 되고 `.loading-fade2`도 hidden인 것을 확인. stale 행수만 읽지 않음.
- `#pager .slick-pager-status`의 현재 전체 행수와 더 가져오기 필요 여부를 확인.
- `span[title="CSV"]` → `그리드 다운로드 v1.1.14` → format `csv4`(UTF-8)와 모든 컬럼 `all` 선택.
- 선택항목·컬럼포맷·보이는내역·그룹합계 옵션 해제. 선택된 원본 헤더를 검증한 뒤 `그리드 다운로드` 버튼 한 번 클릭.
- 클릭 전에 download listener를 설치. 세 파일을 모두 저장하고 추가 파일·행수 변경·누락을 차단. Blob 완료 순서가 바뀌면 원본 행번호로 파일 순서만 정하며 byte는 그대로 유지.

공식 다운로드는 파일명에 초 단위 시각을 넣으므로 여러 원본이 같은 이름으로 내려올 수 있습니다. runner는 원본 행번호로 순서를 확인한 뒤 artifact 이름에 `part-1-`, `part-2-`, `part-3-`을 붙입니다. 매우 긴 이름은 artifact 이름의 본문만 줄여 안전한 길이를 유지하며, 전체 원래 다운로드 이름은 `journal.json`의 각 파일 `originalName`에 보존합니다. 이는 이름의 별칭이고 파일 내용 변환이 아닙니다. 크기와 SHA-256은 원본 그대로입니다.

확인된 selector가 예제 `ui`에 들어 있습니다. `strategy:'grid_csv'`, `format:'csv4'`, `rowsPerFile:10000`이 현재 계약입니다. 총 행수로 계산한 실제 분할 파일 수가 3개가 아니면 `official_part_count_changed`로 중단합니다. 향후 원본이 늘어날 경우 Hub·서버·runner의 3파일 계약을 함께 검토해야 하며, 현재 데이터를 임의로 자르거나 합치지 않습니다. 조회·다운로드 HTTP 요청과 인증정보는 직접 추출하거나 호출하지 않습니다.

## 회사 PC 준비

Node.js 22 이상과 저장소에 고정된 Playwright가 필요합니다. 이 runner는 기존 `sellpia-source-parser.js`와 버전이 고정된 `tests/vendor/xlsx-0.18.5.full.min.js`를 검증에 재사용하므로 전체 checkout에서 실행합니다. 원본은 다시 직렬화하지 않습니다.

설정은 예제를 복사하여 Git 밖의 회사 PC 설정 폴더에 저장합니다. `profileDirectory`와 `workDirectory`는 서로 분리된 절대 경로이어야 합니다. 지정하지 않으면 Windows의 `%LOCALAPPDATA%/OperationHubSellpiaSync/profile`과 `runs`를 사용합니다. 일반 Chrome의 `User Data` 폴더를 지정하거나 복사하지 마세요. 프로필과 원본에는 로그인 상태·회사 원본 데이터가 포함되므로 PC 운영자에게만 접근을 허용합니다.

```powershell
node tools/sellpia-sync/runner.mjs check-config --config "C:\OperationHubLocal\sellpia.local.json"
node tools/sellpia-sync/runner.mjs login --config "C:\OperationHubLocal\sellpia.local.json"
```

`login`은 전용 프로필의 브라우저를 보여줍니다. 사용자가 직접 로그인한 뒤 `Ctrl+C` 또는 마지막 브라우저 페이지 종료로 세션 준비를 마칩니다. runner는 로그인 정보 입력, cookies 추출, storage state 출력, 인증 도전 자동 해결을 하지 않습니다. **2026-10-13 실제 확인에서 headless 재접속은 `needs_login`으로 중단된 반면, headed 재접속은 기존 인증 확인을 통과한 사례가 있습니다. 원인이나 cookie 정책, 재접속의 장기 안정성은 미확인입니다.** 회사 PC의 수집·worker는 아래 화면이 있는 `--login` 경로를 사용하고, 인증이 필요할 때만 사용자가 직접 로그인한 뒤 동일 context를 유지합니다.

공식 분할 다운로드 계약을 확인한 뒤 로컬 수집을 검증합니다.

```powershell
node tools/sellpia-sync/runner.mjs collect --config "C:\OperationHubLocal\sellpia.local.json"
node tools/sellpia-sync/runner.mjs collect --login --repeat 2 --config "C:\OperationHubLocal\sellpia.local.json"
```

이 명령은 로컬 작업 UUID 폴더에 원본 byte와 `journal.json`만 저장합니다. 원본 세 개의 SHA-256·크기·24개 필수 헤더·추가 필드 보존·행번호 연속·SKU 중복·공식 UI 총 행수를 검증합니다. 수집 시점의 행수가 기존 Hub baseline과 같다고 가정하지 않습니다.

공식 UTF-8 CSV에 선두 BOM이 연속해서 들어 있어도 파서는 해석용 문자열의 선두 BOM만 제거합니다. 저장 원본에는 BOM을 포함한 byte가 그대로 남으며, SHA-256도 그 원본 byte 기준입니다. 파일 전체를 다시 쓰거나 컬럼·값을 정규화하지 않습니다.

`--login`은 사용자에게 전용 브라우저를 보여주고 수동 로그인 완료를 기다립니다. 인증 실패 화면의 로그인 링크는 사용자가 클릭하고 정보도 직접 입력합니다. runner는 확인된 `로그아웃` 버튼을 **누르지 않고 표시 여부만 읽어** 로그인 완료를 판단한 뒤 같은 context에서 상품 목록으로 이동하여 검증합니다. 표준 상품 목록에 이미 진입했다면 해당 화면의 인증 표시를 확인합니다. `--repeat 2`는 같은 context에서 각각 새 UUID·새 전체조회로 두 번 수집하며, 기본값은 한 번입니다. 1~3회만 허용합니다. 수집 중에는 브라우저를 닫지 않습니다.

## 큐 worker

서버의 worker 전용 수집 endpoint와 전용 worker secret을 실행 프로세스의 환경변수로 공급합니다. API URL은 정확히 HTTPS `/functions/v1/operations-hub-sellpia-sync`여야 합니다.

- `SELLPIA_SYNC_API_URL`
- `SELLPIA_SYNC_WORKER_TOKEN`

`service_role`, Hub 로그인 session, 셀피아 password, cookies는 worker 환경변수에 넣지 않습니다. 환경 파일을 사용할 때에는 Git 밖에서 운영자만 읽을 수 있게 관리하며, 값은 콘솔·화면·로그에 출력하지 않습니다.

```powershell
node --env-file="C:\OperationHubLocal\worker.env.local" tools/sellpia-sync/runner.mjs worker --login --config "C:\OperationHubLocal\sellpia.local.json"
```

`worker --once`는 한 번의 claim/처리만 수행합니다. 모든 요청은 외부로 나가는 HTTPS이고 회사 PC의 inbound 서버·브라우저 remote-debugging port를 열지 않습니다. claim 후 30초마다 heartbeat를 보내며 lease를 잃으면 수집·전송을 중단합니다. 서버는 raw artifact의 크기·hash 검증을 마친 뒤 `collected`로 전환합니다. **collected는 운영 반영 완료가 아닙니다.**

`worker --login`은 worker 시작 때만 인증을 확인하고 필요하면 수동 로그인을 기다리며, 이후 작업들은 같은 context를 재사용합니다. 개별 job에서 사용자 로그인창을 자동으로 열거나 로그인 정보를 입력하지 않습니다. 같은 context의 연속 수집 두 번은 실제 CLI에서 확인했고, 장시간 후 인증 만료와 회사 PC 재시작에 어떻게 대응할지는 추가 검증이 필요합니다. 만료되면 `needs_login`으로 종료하며 세션 재생성이나 인증 우회를 시도하지 않습니다. 아직 재접속 안정성이 확인되지 않았으므로 시작 작업을 등록하는 것만으로 무인 운영 준비가 끝난다고 볼 수 없습니다.

signed Storage PUT은 같은 API origin의 `/storage/v1/object/upload/sign/` 주소로만 수행하고 worker secret·Authorization·apikey를 전달하지 않습니다. 원본 저장은 overwrite 없이 이루어지며 signed URL은 journal이나 로그에 저장하지 않습니다.

## 실패와 재시작

- 프로필·작업 경로는 Git 밖에 보관합니다. stdout는 작업 ID·오류 코드·상태·집계 숫자만 기록합니다. page console, HTML, screenshot, trace, HAR, 오류 원문은 기본 기록하지 않습니다.
- 작업 중복은 프로세스 lock과 서버 lease로 차단합니다. 비정상 종료 후 `runner.lock`이 남으면 **해당 PC의 기존 runner가 종료되었음을 운영자가 확인한 뒤** lock만 제거합니다. runner는 잠금을 자동 탈취하지 않습니다.
- 다운로드 일부 실패, 행수 불일치, 파일 digest 불일치에서는 완료 manifest를 만들지 않습니다. 브라우저의 `ERR_BLOCKED_BY_CLIENT`나 보안 정책을 해제하지 않습니다.
- 준비 단계는 `PREPARE_*` 코드만 기록하고 실패도 `prepare_<단계>_failed`로 구분합니다. HTML·인증정보·오류 원문을 표시하지 않습니다. 검색키는 전체 선택 시 숨겨지므로 선택 전에 비우며, 이미 빈 숨김 필드는 값이 빈 상태임을 확인하고 불필요한 fill을 건너뜁니다. 숨겨진 비어 있지 않은 검색키를 강제로 수정하지 않습니다.
- 같은 job의 수집 완료 journal은 byte·schema를 다시 검증한 뒤 재사용합니다. 적용 결과가 불명확한 경우 새 운영 업로드를 자동 반복하지 않습니다.
- 로그인 필요 상태에서는 runner를 종료하고 회사 PC 운영자가 `collect --login` 또는 `worker --login`으로 재로그인합니다. 인증과 수집은 같은 context에서 이어지며, 별도 `login` 완료 후 재접속이 유지되는지는 미확인입니다.

## Windows 시작 작업

실제 수집 계약·전용 로그인·worker 서버를 검증한 뒤에만 아래 설치 스크립트를 명시적으로 실행합니다. 스크립트는 현재 Windows 사용자 로그인 시 `worker --login`을 실행할 작업을 등록하고 **즉시 실행하지 않습니다.** 화면이 있는 전용 브라우저에서 인증을 확인하며, 필요하면 운영자가 직접 로그인합니다. 기존 작업을 덮어쓰지 않고 Windows 비밀번호를 저장하지 않습니다.

```powershell
.\tools\sellpia-sync\install-startup.ps1 -Install -ConfigPath "C:\OperationHubLocal\sellpia.local.json" -WorkerEnvironmentFile "C:\OperationHubLocal\worker.env.local"
```

수동 실행 환경과 시작 작업은 같은 프로필·작업 폴더를 사용하므로 동시에 실행하지 않습니다. 운영자가 로그아웃하거나 PC가 꺼져 있으면 worker는 처리할 수 없습니다. Hub는 stale heartbeat를 offline으로 보여주고 수동 원본 업로드 경로를 유지해야 합니다.

## 검증

```powershell
node --test tests/operationsHubSellpiaSyncRunner.test.mjs
```

테스트는 합성 CSV·BIFF8 XLS와 네트워크가 intercept된 단일 버튼·다중 다운로드 브라우저 fixture만 사용합니다. 실제 회사 원본, 셀피아 계정, production queue/Storage/DB에 접근하지 않습니다. 22개 테스트는 double-BOM quoted CSV, 동일한 공식 다운로드 이름 세 개, 역순 download 이벤트, 원본 해시 보존, lease와 인증 분리 등을 검증합니다. 실제 셀피아 성공 증거는 위 회사 PC CLI 수집 결과와 구분하여 기록했습니다.

공식 문서: [Playwright persistent profile](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [downloads](https://playwright.dev/docs/downloads), [인증 상태 보호](https://playwright.dev/docs/auth), [Supabase Queues](https://supabase.com/docs/guides/queues), [signed upload 구현](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts).
