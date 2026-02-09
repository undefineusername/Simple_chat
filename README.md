좋다. 이건 **README에 바로 올려도 되는 수준**으로 써준다.
불필요한 미사여구 빼고, 구조·의도·사용법 중심이다.

---

# 🛡️ Transparent Pipeline Relay v2.1

> **Stateless · Raw · Device-Sync Relay Server**
> 판단하지 않는 서버, 전달만 하는 파이프라인

---

## 1. 개요 (Overview)

**Transparent Pipeline Relay**는
DB 없이 동작하는 **완전 인메모리 실시간 중계 서버**입니다.

서버는 메시지를 **해석·변형·저장하지 않고**,
클라이언트 간 데이터를 그대로 전달하는 **투명한 터널** 역할만 수행합니다.

### 핵심 철학

* ❌ 비즈니스 로직 없음
* ❌ 데이터베이스 없음
* ❌ 영속 저장 없음
* ✅ Raw 데이터 그대로 전달
* ✅ 오프라인 시 임시 큐잉
* ✅ 디바이스 간 즉시 동기화

---

## 2. 주요 기능 (Features)

* **Master / Slave 구조**

  * 모바일 = Master
  * PC / 기타 기기 = Slave
* **연동 코드 기반 디바이스 연결**
* **Raw Relay**

  * JSON / Text / Binary 모두 통과
* **오프라인 메시지 큐**

  * 최대 30분 보관
  * 재접속 즉시 자동 전달
* **Echo Sync**

  * 동일 계정의 다른 기기에 자동 반영
* **완전 Stateless (RAM Only)**

---

## 3. 아키텍처 개념

```
[ Device A ] ─┐
               ├── Transparent Relay Server ──┐
[ Device B ] ─┘                                ├─> [ Device C ]
                                                └─> [ Device D ]
```

서버는 **중계만** 하며,
메시지의 의미·타입·처리는 모두 클라이언트 책임입니다.

---

## 4. 데이터 구조

### Groups

```js
hardwareId -> {
  master: socketId,
  slaves: Set<socketId>,
  syncCode,
  expires
}
```

### Socket Mapping

```js
socketId -> hardwareId
```

### Sync Codes

```js
code -> hardwareId
```

### Offline Queue

```js
hardwareId -> [{ payload, expiresAt }]
```

---

## 5. 이벤트 흐름 (Event Flow)

### ① Master 등록

```js
register_master(hardwareId)
```

* 디바이스 그룹 생성
* 기존 큐 자동 수신

---

### ② 연동 코드 요청

```js
request_sync_code
```

* 6자리 HEX 코드 발급
* 유효 시간: 5분

---

### ③ Slave 연결

```js
link_pc(code)
```

* 코드 검증 후 동일 그룹 편입
* 큐 자동 플러시

---

### ④ Raw 데이터 중계

```js
raw_relay({ toId, data })
```

**처리 로직**

1. 페이로드 크기 검사 (최대 5MB)
2. 실시간 전달 시도
3. 실패 시 오프라인 큐 저장
4. 송신자에게 상태 반환
5. 동일 계정 기기로 Echo 전파

---

## 6. 오프라인 큐 (Tunnel Queue)

| 항목    | 값          |
| ----- | ---------- |
| 보관 시간 | 30분        |
| 최대 개수 | 100개 / 사용자 |
| 저장 방식 | 메모리 (RAM)  |
| 전달 시점 | 재접속 즉시     |

---

## 7. 설정 값

```js
MAX_PAYLOAD_SIZE = 5MB
QUEUE_TTL        = 30 minutes
MAX_QUEUE_SIZE   = 100
SYNC_CODE_TTL    = 5 minutes
CLEANUP_INTERVAL = 1 minute
```

---

## 8. Legacy 지원

기존 테스트용 HTML을 위한 이벤트를 유지합니다.

```js
direct_message
push
mark_as_read
```

> 신규 프로젝트에서는 `raw_relay` 사용을 권장합니다.

---

## 9. 보안 및 한계 (Important)

⚠️ **프로덕션 사용 시 주의**

* 서버 재시작 시 모든 데이터 소멸
* 멀티 인스턴스 미지원
* 인증 / 권한 검증 없음
* DDoS 방어 없음

👉 실제 서비스에서는 아래 추가 권장:

* Redis (큐 & 브로드캐스트)
* JWT / Device Auth
* Rate Limit
* HTTPS + Reverse Proxy

---

## 10. 실행 방법

```bash
npm install
node server.js
```

기본 포트: `3000`

헬스 체크:

```
GET /ping → pong
```

---

## 11. 사용 사례

* 모바일 ↔ PC 실시간 동기화
* 디바이스 간 메시지 브리지
* P2P 시그널 서버
* 실험용 메신저 백엔드
* IoT 제어 중계 서버

---

## 12. 철학 (Philosophy)

> **“서버는 판단하지 않는다.”**
> **“클라이언트가 모든 의미를 가진다.”**

Transparent Pipeline은
**최소 개입 · 최대 자유**를 목표로 합니다.

---

필요하면 다음도 바로 써줄 수 있다:

* 📄 **SECURITY.md**
* 🧪 **프로토콜 스펙 문서**
* 🚀 **Redis 기반 v3 아키텍처**
* 🔐 **JWT 인증 확장 README**

원하는 다음 단계 말해.
