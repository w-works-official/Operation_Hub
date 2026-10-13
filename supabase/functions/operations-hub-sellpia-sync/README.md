# Sellpia 원본 수집 staging endpoint

이 코드는 로컬 검증용 구현입니다. 새 schema 적용, Edge 배포, PC runner 인증 설정, Storage ACL 검토를 완료하기 전에는 실행할 수 없습니다. `SELLPIA_SYNC_ENABLED`의 기본값은 꺼짐이며, 승인 후 활성화하더라도 `applyProduction`은 항상 `false`입니다. 운영 source import 및 snapshot 완료 RPC를 호출하는 경로는 없습니다.

브라우저는 회사 Pages origin 또는 HTTP localhost에서 `x-operations-hub-session`으로 인증합니다. 기존 `operations_hub_check_session_v1`의 `authenticated` 결과를 매번 확인합니다. 현재 Hub의 운영자 모델에 맞춰 인증된 운영자는 작업 상태·원본을 조회할 수 있습니다. 새 `auth.uid()` 가정을 만들지 않습니다.

회사 PC runner는 HTTPS outbound 요청과 `x-sellpia-sync-worker-token`을 사용합니다. Edge의 `SELLPIA_SYNC_WORKER_ID`와 요청 `workerId`가 같아야 합니다. PC에는 별도 worker credential만 설정하며 Hub 운영 세션, Supabase service-role key, Sellpia 쿠키를 전달하지 않습니다. 토큰과 signed URL은 로그에 쓰지 않습니다.

POST 응답은 `{ok:true,version,job,...}` 형태이며 `data` wrapper를 사용하지 않습니다. 오류는 고정된 `{ok:false,code,message}`입니다. worker lease는 120초, heartbeat 권장 간격은 30초이며 `leaseExpiresAt`은 epoch milliseconds입니다. 동시 collecting job은 전역에서 하나입니다. 만료된 작업은 실패로 종료되며 이전 lease로 결과를 제출할 수 없습니다. 완료 응답 유실 후 같은 lease의 finalize 재시도는 결과만 반환합니다.

| 구분 | action | 요청의 추가 필드 |
|---|---|---|
| 운영 화면 | enqueue | requestId UUID, mode full/patch, selectedFields, baselineSnapshotId |
| 운영 화면 | status / artifacts / cancel | jobId |
| 운영 화면 | receipt | jobId, receipt(valid true, rowCount, sourceFingerprint, baselineSnapshotId, bounded summary) |
| runner | claim | workerId |
| runner | heartbeat | workerId, jobId, leaseToken |
| runner | report | workerId, jobId, leaseToken, state collecting/failed/needs_login, aggregate summary |
| runner | upload-init | workerId, jobId, leaseToken, collectionManifest |
| runner | upload-finalize | workerId, jobId, leaseToken |

full manifest는 `{source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount,files:[{ordinal,name,size,sha256}]}`입니다. 파일은 3개, 각 25 MiB 이하, 합계 60 MiB 이하입니다. 경로는 서버가 `sellpia-sync/<job UUID>/<ordinal>.<extension>`으로 정합니다. private bucket에 immutable signed upload를 사용하고 finalize에서 실제 object 개수·크기와 파일 bytes의 SHA-256을 순서대로 확인합니다.

runner는 반환된 `signedUrl`에 HTTP PUT으로 원본 bytes를 보냅니다. `content-type`, `x-upsert:false`, `cache-control:max-age=0`만 사용하며 worker token과 서비스 키를 Storage URL에 전송하지 않습니다. 이 방식은 [공식 storage-js의 uploadToSignedUrl](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts)에 맞췄습니다.

artifacts 응답에는 독립적인 `manifest`와 `artifacts:[{ordinal,name,size,sha256,signedUrl}]`, `expiresIn:300`이 있습니다. 브라우저가 내려받은 bytes를 다시 검증하고 기존 전체 원본 파서로 preflight를 실행한 뒤 receipt를 제출합니다. receipt에는 원본 행, SKU 목록, 공급처·상품명, 오류 원문을 저장하지 않습니다.

`docs/sellpia-sync-schema-proposal.sql`은 실행하지 않은 운영 schema 제안입니다. 로컬 PGlite에서 ACL, 요청 중복, CAS 동시성, commit 시 lease 만료를 검증합니다. private queue 테이블에 RLS를 켜고 익명/일반 authenticated 권한을 회수합니다. 공개 RPC는 `SECURITY INVOKER`이며 service_role에만 EXECUTE를 부여하여 private schema를 Data API에 노출하지 않습니다.

별도 승인 후 배포 설정에는 `[functions.operations-hub-sellpia-sync] verify_jwt=false`가 필요합니다. 이 함수는 Supabase Auth JWT 대신 위 두 custom 인증을 확인하기 때문입니다. [공식 인증 헤더 문서](https://supabase.com/docs/guides/functions/auth-headers)를 기준으로 설정하되 다른 함수의 설정을 바꾸지 않습니다.

[signed upload 권한은 2시간 유효](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)하므로 120초 lease 만료가 이미 발급한 Storage 권한 자체를 회수하지는 않습니다. 늦은 업로드는 고립된 staging object가 될 수 있지만 완료 및 신규 다운로드는 차단됩니다. 이미 발급한 5분 signed download도 취소로 회수되지 않습니다. 활성화 전 Storage 정책이 새 prefix를 서버 전용으로 제한하는지 검토하고, 실패·취소 object 보존 기간 및 정리 절차를 별도로 승인해야 합니다.
