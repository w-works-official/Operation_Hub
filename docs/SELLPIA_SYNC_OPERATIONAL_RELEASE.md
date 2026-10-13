# 셀피아 전체 원본 동기화 운영 적용 계획

이 변경은 회사 `Operation_Hub`의 기존 수집기와 원본 처리 경로를 연결한다.
운영 DB, 회사 main, Pages, Windows 시작 작업은 별도 승인 후 적용한다.
기본 실행은 미리보기이며 Edge와 DB의 자동 반영 설정은 모두 비활성이다.

## 처리 계약

1. 인증된 Hub 운영자가 원본 관리에서 작업을 요청한다.
2. private 작업 큐가 request UUID, 운영자, 기준 ready snapshot, 반영 모드와 필드를 고정한다.
3. 회사 PC worker가 outbound 통신으로 claim하고 lease를 갱신한다.
4. 셀피아의 정식 CSV 그리드 다운로드에서 전체 원본 3개를 수집한다.
5. 기존 파서로 헤더, 숫자, 행번호, SKU, 파일 크기와 SHA-256을 검증한다.
6. private staging에서 서버가 실제 원본 byte를 검증한다.
7. 브라우저는 기존 파서와 최신 ready 원본을 비교한다.
8. 허용된 경우에만 작업 전용 반영 권한으로 기존 signed original upload,
   rows RPC, completion RPC를 실행한다.
9. ready snapshot과 같은 snapshot의 Matrix 재구성을 확인해야 전체 완료이다.

초기 통합에서는 인증된 Hub 탭이 파서·비교·기존 업로드를 실행하므로 완료까지
탭을 유지한다. 회사 PC는 탭과 별개로 수집 작업을 계속 수행한다. DB 반영 이후
탭이나 응답이 끊긴 경우 기존 intent/snapshot으로 Matrix 복구를 수행하고 원본을
재업로드하지 않는다. Hub 탭 없이 서버가 전체 후속 처리를 끝내는 구조는 이
변경의 실행 경로가 아니다. 미리보기와 반영의 권한 경계를 유지한다.

수집 범위는 항상 전체 3개 파일이다. `applicationMode: patch`는 수동 업로드와
동일한 선택 필드 갱신이며, `full`은 기존 전체 교체 계약이다. 전체 수집을 했다는
이유로 수동 가격, 운영 master, 태그, 매핑, 규칙을 초기화하지 않는다.
판매가와 기존 `price/basePrice` 별칭, 매입가와 수수료·부가세의 비교/갱신 경계는
기존 SQL 정책을 따른다. 재고조사 `inventory_count`는 별도 계약을 유지한다.

## 첫 실제 원본 검토

2026-10-13 수집 27,278 SKU와 2026-10-08 ready 원본 23,816 SKU의 대조:

| 구분 | SKU 수 |
|---|---:|
| 공통 | 23,763 |
| 수집 원본에만 존재 | 3,515 |
| DB에만 존재 | 53 |
| 순증가 | 3,462 |

수집 원본에만 있는 SKU는 정상 97, 단종 3,418이다. 실등록일은 모두 기존
snapshot 날짜보다 이전이다. 최근 신규 등록이라고 확정할 수 없고, 이전 수집
범위 차이의 정확한 원인도 아직 확인하지 않았다. 기존 DB에만 있는 53개는 정상이다.
첫 적용에서 이 차이를 무검토 전체 교체하지 않는다. patch는 기존 DB 전용 SKU를
보존한다. 큰 추가와 full 누락은 서버가 실제 저장 행 집합으로 다시 검사한다.

기본 정책은 추가 수가 100과 기준의 5% 중 큰 값을 초과하거나 full에서 누락이 발생하면
검토를 요구한다. 승인 예외는 검토한 정확한 `approved_source_fingerprint`에만
연결하며, 다른 원본·정책·기준 snapshot에는 재사용하지 않는다. 브라우저 확인창은
서버 승인을 대체하지 않는다. 운영 적용 전 실제 정책을 담당자가 검토해야 한다.

## 운영 적용 순서

모든 단계는 사용자의 운영 적용 승인 후 진행한다.

1. 진행 중 수동 업로드와 작업을 확인하고 현재 함수 정의·설정의 복구 자료를 확보한다.
2. timeout 변경이 적용됐는지 정의와 ledger를 확인한다. 2026-10-13 재확인한 회사
   Production에는 원격 version `20261013072114`로 이미 적용됐다. 저장소 파일
   `20261013045421_sellpia_inventory_count_fixed_key_copy.sql`과 같은 변경이며
   다시 적용하거나 ledger를 임의로 맞추거나 blanket `db push`하지 않는다.
3. 큐/반영 경계 `20261013071210_sellpia_sync_operational_queue.sql`을 적용한다.
   timeout 최적화 본문을 private delegate로 보존한 뒤 기존 v1/v2 시그니처를 감싼다.
   `docs/sellpia-sync-schema-proposal.sql`은 이전 검토 초안이며 별도로 적용하지 않는다.
4. `operations-hub-original-files`와 `operations-hub-sellpia-sync`를 함께 배포한다.
   새 원본 함수는 새 migration의 상태 검사에 의존하므로 SQL보다 먼저 배포하지 않는다.
5. `seller-originals` private, staging restrictive RLS, 기존 원본 접근 경계를 확인한다.
6. Edge에서 `SELLPIA_SYNC_ENABLED=true`를 켜되 `SELLPIA_SYNC_APPLY_ENABLED=false`를 유지한다.
   private DB `apply_enabled`도 false를 유지한다.
7. PC마다 다른 worker secret을 Edge의 `SELLPIA_SYNC_WORKERS_JSON`에 공급하고
   해당 PC의 Git 밖 환경 파일에 자기 키만 저장한다. worker에 service role을 주지 않는다.
8. 승인된 회사 frontend를 배포하고 수집·전달·미리보기만 먼저 검증한다.
9. 별도 격리 Supabase 환경의 실제 Storage/Edge 전 구간 검증을 완료한다.
10. 실제 SKU 차이와 필드 선택, baseline을 검토한 후 첫 snapshot 반영을 별도 승인한다.
11. snapshot/Matrix, 가격·상태·운영 master·매핑 보존을 확인한 뒤 정상 자동 모드를 승인한다.
12. 회사 PC 상주 안정성을 검증한 후 사용자가 Windows 시작 작업을 설치한다.

Supabase의 function JWT 설정은 기존 custom 운영 세션 검사를 통과할 수 있게
구성해야 한다. 검증을 끄는 경우에도 handler의 운영 세션·Origin·PC 인증을 유지한다.
설정값/Secret을 저장소, frontend, URL 또는 로그에 기록하지 않는다.

## 회사 PC 운영

Git 밖 전용 프로필, 원본 작업 폴더, 설정 파일, worker 환경 파일을 사용한다.
`tools/sellpia-sync/README.md`의 관리 스크립트로 Start/Stop/Status를 실행한다.
전용 headed 브라우저는 동일 context를 유지하고 세션 만료 시 사용자의 로그인만
기다린다. 비밀번호 입력이나 CAPTCHA 우회를 자동화하지 않는다.
브라우저 세션이 PC 재부팅 후 장기간 유지된다고 가정하지 않는다.

페이지가 PC의 localhost를 직접 호출하지 않는다. 다른 PC의 Hub도 인증된 서버
큐를 통해 회사 worker에 요청한다. worker PC가 켜져 있고 Windows 사용자 세션이
유지되어야 한다. offline/needs_login 상태에서는 새 수집 요청을 막고 수동 업로드를
계속 제공한다. profile과 영업 원본은 운영자만 읽을 수 있도록 OS 권한을 관리한다.

## 장애 및 롤백

- 같은 request UUID를 재조회하고, 완료 응답 유실에 새 수집/업로드를 만들지 않는다.
- 만료된 lease는 늦은 수집 결과를 반영할 수 없다. 다른 PC도 같은 작업을 중복 claim할 수 없다.
- 업로드 일부 실패, checksum 오류, 행 누락, 중복 SKU, baseline 변경은 ready 승격을 차단한다.
- DB ready 이후 Matrix 실패는 기존 snapshot의 Matrix 복구만 수행한다.
- 상태가 불명확하면 조회로 서버 완료/실패를 확인할 때까지 재반영을 차단한다.
- staging 정리는 실패/취소 3시간, 미리보기/완료 7일 후 서버에서 제한된 경로만 수행한다.
  영구 `sellpia/<snapshot>` 원본이나 ready snapshot을 삭제하지 않는다.
- UI/Edge를 먼저 비활성화하고 PC worker를 중지한다. 진행 중 intent를 확인하고
  sync rollback을 먼저 검토한다. 기존 승인된 timeout 최적화는 유지한다.
  timeout rollback은 이 기능의 롤백에 포함하지 않고 별도 필요 여부와 승인을 판단한다.
- Git/Pages 롤백은 이미 갱신된 원본 DB를 되돌리지 않는다. 데이터 복구는 보존된
  snapshot과 별도 승인 절차로 처리한다.

## 검증 범위의 구분

실제 CSV 수집, 실제 PostgreSQL snapshot/Matrix, Deno/PostgREST HTTP, 브라우저 및
PGlite 계약 테스트 결과는 각각 보고한다. 합성 Storage adapter 통과를 실제
Supabase Storage 통과로 표시하지 않는다. 현재 Windows 환경에서는 공식 Storage
패키지의 플랫폼 제약과 Docker engine 미응답이 있고, 사용자는 클라우드 QA 생성을
보류했다. 이 전 구간 검증은 Production 활성화 전 남은 조건이다.
