# socat Workstation 포트 포워딩

> Freshness: 2026-03-08T00:30:00+09:00

## socat이란

`socat` (SOcket CAT)은 **양방향 데이터 전송 릴레이 도구**다. 두 개의 네트워크 소켓을 연결해서 한쪽으로 들어온 트래픽을 다른 쪽으로 전달한다. `cat`이 파일을 읽어 stdout으로 보내듯, socat은 소켓 간 데이터를 중계한다.

```
클라이언트 → [socat LISTEN:3100] → [TCP:192.168.0.2:3100] → 워크스테이션
            ←                     ←                         ←
```

설치: `brew install socat`

## 왜 필요한가

### 문제: OrbStack Docker와 LAN 네트워크 격리

session-dashboard는 OrbStack Docker 컨테이너에서 실행된다. OrbStack은 내부적으로 Linux VM 위에서 Docker를 실행하며, 이 VM은 **macOS host의 LAN 네트워크(192.168.0.x)에 직접 접근할 수 없다**.

```
┌─────────────────── macOS Host ───────────────────┐
│  LAN: 192.168.0.63                               │
│  ✅ 192.168.0.2:3100 접근 가능                     │
│                                                   │
│  ┌──────────── OrbStack Linux VM ──────────────┐  │
│  │  네트워크: 192.168.139.x (격리된 서브넷)       │  │
│  │  ❌ 192.168.0.2 접근 불가 (No route to host)  │  │
│  │                                              │  │
│  │  ┌── Docker Container ──┐                    │  │
│  │  │  session-dashboard   │                    │  │
│  │  │  ❌ LAN 직접 접근 불가 │                    │  │
│  │  └──────────────────────┘                    │  │
│  └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

| 테스트 출발지 | 목적지 192.168.0.2:3100 | 결과 |
|---|---|---|
| macOS host | 직접 연결 | ✅ 정상 (4ms) |
| Docker bridge mode | 직접 연결 | ❌ timeout |
| Docker `network_mode: host` | 직접 연결 | ❌ timeout (VM의 host 네트워크) |

### 해결: socat 포트 포워딩

macOS host에서 socat을 실행하여 `localhost:3100`으로 들어오는 요청을 `192.168.0.2:3100`으로 전달한다. Docker 컨테이너는 `host.docker.internal:3100`을 통해 macOS host의 localhost:3100에 접근할 수 있으므로, 간접적으로 워크스테이션에 도달한다.

```
┌─────────────────── macOS Host ───────────────────┐
│                                                   │
│  socat (nohup)                                    │
│  localhost:3100 ──────────→ 192.168.0.2:3100      │
│       ↑                         (워크스테이션)      │
│       │                                           │
│  ┌────┴─────── OrbStack Docker ────────────────┐  │
│  │  session-dashboard                          │  │
│  │  → host.docker.internal:3100 ✅              │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

## 기동 절차 (처음부터)

### 1. socat 설치

```bash
brew install socat
```

### 2. machines.yml 설정 확인

`services/session-dashboard/machines.yml`에서 workstation의 host가 `host.docker.internal`인지 확인:

```yaml
machines:
  - id: workstation
    alias: Workstation (192.168.0.2)
    host: host.docker.internal     # ← 192.168.0.2가 아닌 host.docker.internal
    port: 3100
    apiKey: <your-api-key>
    source: opencode
```

> ⚠️ `host: 192.168.0.2`로 설정하면 Docker 컨테이너에서 직접 접근이 불가능하므로 반드시 `host.docker.internal`을 사용한다.

### 3. socat 포트 포워딩 시작

```bash
cd services/session-dashboard
./socat-workstation.sh start
```

출력 예시:
```
socat-workstation started (PID 44886)
  localhost:3100 → 192.168.0.2:3100
```

### 4. session-dashboard 시작 (Docker)

```bash
cd services/session-dashboard
docker compose up -d
```

### 5. 동작 확인

```bash
# 1) socat 포워딩 확인
curl http://localhost:3100/health
# → {"status":"ok","version":"1.0.0",...}

# 2) Dashboard API에서 머신 상태 확인
curl http://localhost:3097/api/machines | python3 -m json.tool
# → workstation status: "connected"

# 3) Dashboard 웹 UI 확인
open http://localhost:3097
```

## 관리 명령어

```bash
# 상태 확인
./socat-workstation.sh status

# 중지
./socat-workstation.sh stop

# 시작 (기본 명령)
./socat-workstation.sh start
```

## 재부팅 후 복구

socat은 `nohup`으로 실행되므로 **재부팅 시 자동 시작되지 않는다**. 재부팅 후 수동으로 시작해야 한다:

```bash
cd ~/project/bae-settings/services/session-dashboard
./socat-workstation.sh start
docker compose up -d
```

> **참고**: macOS LaunchAgent로 자동화를 시도했으나, launchd 프로세스 환경에서 LAN 라우팅이 작동하지 않는 macOS 제한이 있어 nohup 방식을 사용한다.

## 트러블슈팅

### socat 시작 실패

```bash
# 포트 점유 확인
lsof -i :3100

# 기존 socat 정리 후 재시작
./socat-workstation.sh stop
./socat-workstation.sh start
```

### workstation이 disconnected로 표시

1. **socat 실행 확인**: `./socat-workstation.sh status`
2. **워크스테이션 네트워크 확인**: `ping 192.168.0.2`
3. **dashboard-agent 실행 확인**: `curl http://192.168.0.2:3100/health`
4. **socat 포워딩 확인**: `curl http://localhost:3100/health`
5. **Docker 컨테이너 로그 확인**: `docker logs session-dashboard --tail 20`

### "socket hang up" 에러 (dashboard 로그)

socat이 실행 중이지만 워크스테이션의 dashboard-agent가 응답하지 않는 경우 발생. 워크스테이션에서 agent 상태를 확인한다.

### Grace Period 동작

machine-manager에 grace period가 설정되어 있어, **3회 연속 poll 실패** 후에만 disconnected로 전환된다 (약 6초). 일시적인 네트워크 불안정에 의한 false disconnect를 방지한다.

| 연속 실패 횟수 | 상태 | 설명 |
|---|---|---|
| 1~2회 | 이전 상태 유지 | Grace period 내 — connected 유지 |
| 3회 이상 | `disconnected` | Threshold 초과 — 상태 변경 |
| 성공 1회 | `connected` | Failure counter 즉시 리셋 |

## 전체 데이터 흐름

```
session-dashboard (Docker :3097)
    │
    ├── polls host.docker.internal:3101 → MacBook Pro dashboard-agent
    │
    └── polls host.docker.internal:3100
            │
            └── socat (macOS host, nohup)
                    │
                    └── TCP → 192.168.0.2:3100 → Workstation dashboard-agent
                                                        │
                                                        ├── reads cards.jsonl, queries.jsonl
                                                        └── proxies → oc-serve :4096
```

## 관련 파일

| 파일 | 역할 |
|------|------|
| `services/session-dashboard/socat-workstation.sh` | socat start/stop/status 관리 스크립트 |
| `services/session-dashboard/machines.yml` | 머신 설정 (host, port, apiKey) |
| `services/session-dashboard/docker-compose.yml` | Dashboard Docker 설정 |
| `services/session-dashboard/src/machines/machine-manager.ts` | 머신 폴링 + grace period 로직 |
| `/tmp/socat-workstation.pid` | socat PID 파일 |
| `/tmp/socat-workstation.log` | socat 로그 파일 |

## Related

- [[services]] - Discord relay 등 서비스 구조
- [[architecture]] - 전체 시스템 아키텍처
