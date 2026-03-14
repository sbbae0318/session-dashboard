# 배포 검증 체크리스트

배포 후 브라우저에서 수동 확인할 항목. 테스트/운영 장비 모두 동일하게 적용.

## 기본 동작

- [ ] 대시보드 메인 페이지 로드 (`/`)
- [ ] `/health` 엔드포인트 응답 `{"status":"ok"}`
- [ ] `/api/machines` 에서 등록된 머신 목록 반환

## 세션 표시

- [ ] Active Sessions 영역에 세션 카드 표시
- [ ] 세션 상태 배지 정상 (Working / Waiting / Done / Idle / Stale)
- [ ] 세션 제목 표시
- [ ] 마지막 활동 시간 표시 (상대 시간: "3분 전" 등)
- [ ] lastPromptTime → lastActivityTime 포맷 표시

## 머신 연결

- [ ] 등록된 모든 머신이 `connected` 상태
- [ ] 머신별 세션 데이터 수집 정상

## 실시간 업데이트

- [ ] SSE를 통한 실시간 세션 상태 변경 반영
- [ ] 세션 Working ↔ Waiting 전환 정상

## API 검증 (curl)

```bash
# 대시보드 URL을 환경에 맞게 변경
DASHBOARD=http://192.168.0.63:3097  # 또는 http://192.168.0.2:3097

# 헬스
curl -sf $DASHBOARD/health | python3 -m json.tool

# 머신 목록
curl -sf $DASHBOARD/api/machines | python3 -m json.tool

# 세션 목록
curl -sf $DASHBOARD/api/sessions | python3 -m json.tool
```

## 변경 기능 특화 확인

위 기본 체크리스트에 더해, 이번 변경에서 수정/추가한 기능을 구체적으로 테스트한다.
변경 내용에 따라 해당 항목을 추가 기입.

- [ ] (변경 기능 1): ...
- [ ] (변경 기능 2): ...

## Docker 검증

```bash
# 컨테이너 상태
docker ps --filter name=session-dashboard

# 컨테이너 로그 (최근 20줄)
docker logs session-dashboard --tail 20

# 헬스체크 상태
docker inspect session-dashboard --format='{{.State.Health.Status}}'
```

## 비파괴 확인 (리그레션)

이전 기능이 깨지지 않았는지 확인:

- [ ] OpenCode 세션 정상 표시
- [ ] Claude Code 세션 정상 표시
- [ ] 세션 정렬 순서 정상 (최근 활동 → 오래된 활동)
- [ ] 세션 클릭 시 상세 정보 표시
