const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());

// 정적 파일 서빙 (test.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/**
 * [Data Structure]
 * groups: Map<hardwareId, { 
 *    master: socketId|null, 
 *    slaves: Set<socketId>, 
 *    syncCode: string|null, 
 *    expires: number|null,
 *    temp_queue: Array<{msg, timestamp, ttl}>,
 *    isOnline: boolean,
 *    unreadCounts: Map<fromId, count>
 * }>
 * socketToId: Map<socketId, hardwareId>
 * syncCodes: Map<code, hardwareId>
 */
const groups = new Map();
const socketToId = new Map();
const syncCodes = new Map();

// 상수 정의
const MESSAGE_TTL = 10 * 60 * 1000; // 10분
const SYNC_CODE_TTL = 5 * 60 * 1000; // 5분
const CLEANUP_INTERVAL = 60 * 1000; // 1분마다 정리

// 인증 코드 생성 함수 (6자리 난수)
const generateSyncCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// 현재 ISO 타임스탬프 생성 (재사용 가능)
const getTimestamp = () => new Date().toISOString();

// 헬퍼: 그룹 전체에 메시지 브로드캐스트
const broadcastToGroup = (group, message) => {
  if (!group) return;
  if (group.master) io.to(group.master).emit('push', message);
  group.slaves.forEach(sid => io.to(sid).emit('push', message));
};

// 헬퍼: 읽지 않은 메시지 수 증가
const incrementUnreadCount = (group, fromId) => {
  if (!group.unreadCounts) group.unreadCounts = new Map();
  const currentCount = group.unreadCounts.get(fromId) || 0;
  group.unreadCounts.set(fromId, currentCount + 1);
  return currentCount + 1;
};

// 헬퍼: 읽지 않은 메시지 수 초기화
const resetUnreadCount = (group, fromId) => {
  if (!group.unreadCounts) group.unreadCounts = new Map();
  group.unreadCounts.set(fromId, 0);
};

// 헬퍼: 모든 읽지 않은 메시지 수 가져오기
const getUnreadCounts = (group) => {
  if (!group.unreadCounts) return {};
  const counts = {};
  for (const [fromId, count] of group.unreadCounts.entries()) {
    if (count > 0) counts[fromId] = count;
  }
  return counts;
};

// 헬퍼: 만료된 큐 메시지 정리
const cleanExpiredMessages = (group, now = Date.now()) => {
  const beforeCount = group.temp_queue.length;
  group.temp_queue = group.temp_queue.filter(item => now < item.ttl);
  const removed = beforeCount - group.temp_queue.length;
  return removed;
};

// 헬퍼: 유효한 메시지 필터링 및 전송
const flushMessageQueue = (group, socketId, now = Date.now()) => {
  if (group.temp_queue.length === 0) return 0;

  const validMessages = group.temp_queue.filter(item => now < item.ttl);

  validMessages.forEach(item => {
    io.to(socketId).emit('push', item.msg);
    group.slaves.forEach(sid => io.to(sid).emit('push', item.msg));
  });

  group.temp_queue = [];
  return validMessages.length;
};

// 주기적인 만료 데이터 정리 (메모리 최적화)
setInterval(() => {
  const now = Date.now();
  let totalCleaned = 0;

  // 만료된 sync code 정리
  for (const [code, hardwareId] of syncCodes.entries()) {
    const group = groups.get(hardwareId);
    if (group && group.expires && group.expires < now) {
      syncCodes.delete(code);
      group.syncCode = null;
      group.expires = null;
    }
  }

  // 만료된 메시지 정리
  for (const [hardwareId, group] of groups.entries()) {
    const removed = cleanExpiredMessages(group, now);
    totalCleaned += removed;
  }

  if (totalCleaned > 0) {
    console.log(`🧹 주기 정리: ${totalCleaned}개 만료 메시지 삭제`);
  }
}, CLEANUP_INTERVAL);

io.on('connection', (socket) => {
  console.log(`🔌 새 연결: ${socket.id}`);

  // ① 마스터 등록 (register_master)
  socket.on('register_master', (hardwareId) => {
    // 입력 검증
    if (!hardwareId || typeof hardwareId !== 'string') {
      socket.emit('error_msg', { message: "유효하지 않은 hardwareId입니다." });
      return;
    }

    if (!groups.has(hardwareId)) {
      groups.set(hardwareId, {
        master: socket.id,
        slaves: new Set(),
        syncCode: null,
        expires: null,
        temp_queue: [],
        isOnline: true,
        unreadCounts: new Map()
      });
    } else {
      const group = groups.get(hardwareId);
      group.master = socket.id;
      group.isOnline = true;

      // 🔥 Pull on Connect: 큐에 쌓인 메시지 즉시 플러시
      if (group.temp_queue.length > 0) {
        const queueSize = group.temp_queue.length;
        console.log(`📬 큐 플러시: ${queueSize}개 메시지 전송 (${hardwareId})`);

        const now = Date.now();
        const validCount = flushMessageQueue(group, socket.id, now);

        console.log(`✅ 큐 비움 완료 (유효: ${validCount}개)`);
      }
    }

    socketToId.set(socket.id, hardwareId);
    console.log(`📱 Master 등록: ${hardwareId} -> ${socket.id}`);
    socket.emit('registered', { type: 'master', hardwareId });
  });

  // ② 인증 코드 생성 (request_sync_code)
  socket.on('request_sync_code', () => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);

    if (!group || group.master !== socket.id) {
      socket.emit('error_msg', { message: "마스터만 코드를 생성할 수 있습니다." });
      return;
    }

    const code = generateSyncCode();
    const expires = Date.now() + SYNC_CODE_TTL;

    // 이전 코드 제거
    if (group.syncCode) syncCodes.delete(group.syncCode);

    group.syncCode = code;
    group.expires = expires;
    syncCodes.set(code, hardwareId);

    console.log(`🔑 코드 생성 [${hardwareId}]: ${code}`);
    socket.emit('sync_code', { code, expires });
  });

  // ③ 슬레이브 연동 (link_pc)
  socket.on('link_pc', (code) => {
    // 입력 검증
    if (!code || typeof code !== 'string') {
      socket.emit('error_msg', { message: "유효하지 않은 코드입니다." });
      return;
    }

    const hardwareId = syncCodes.get(code);
    const group = groups.get(hardwareId);

    if (group && group.expires > Date.now()) {
      group.slaves.add(socket.id);
      socketToId.set(socket.id, hardwareId);

      console.log(`💻 PC 연동 성공: ${socket.id} -> Group ${hardwareId}`);
      socket.emit('registered', { type: 'slave', hardwareId });

      // 마스터에게도 알림
      if (group.master) {
        io.to(group.master).emit('slave_linked', { slaveId: socket.id });
      }
    } else {
      socket.emit('error_msg', { message: "유효하지 않거나 만료된 코드입니다." });
    }
  });

  // ④ 내부 동기화 (message_relay): 같은 HardwareID 그룹 내 모든 기기(폰+PC)에 전송
  socket.on('message_relay', (payload) => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);

    if (!group) return;

    // 객체 생성 최적화: 필요한 필드만 추가
    payload.from = hardwareId;
    payload.type = 'sync';
    payload.timestamp = getTimestamp();

    broadcastToGroup(group, payload);
  });

  // ⑤ 유저 간 채팅 (direct_message): 다른 HardwareID 그룹으로 전송
  socket.on('direct_message', ({ toId, text }) => {
    const fromId = socketToId.get(socket.id);

    // 입력 검증
    if (!fromId || !toId || !text) return;

    const fromGroup = groups.get(fromId);
    const toGroup = groups.get(toId);

    if (!toGroup) {
      socket.emit('error_msg', { message: "존재하지 않는 사용자입니다." });
      return;
    }

    const timestamp = getTimestamp();
    const basePayload = { from: fromId, to: toId, text, timestamp };

    // 1. 발신자 그룹 전체에 전송 (내가 보낸 메시지 동기화)
    if (fromGroup) {
      broadcastToGroup(fromGroup, { ...basePayload, type: 'sent' });
    }

    // 2. 수신자 그룹 전체에 전송
    const receivedData = { ...basePayload, type: 'received' };

    // 🔥 Presence Tracking: 온라인 상태 확인
    if (toGroup.isOnline && toGroup.master) {
      // 온라인 → 즉시 전송 + 읽지 않은 메시지 수 증가
      const unreadCount = incrementUnreadCount(toGroup, fromId);
      receivedData.unreadCount = unreadCount;

      broadcastToGroup(toGroup, receivedData);
      console.log(`💬 Chat: ${fromId} -> ${toId} (즉시 전송, 읽지않음: ${unreadCount})`);
    } else {
      // 🔥 Dead-Letter Queue: 오프라인 → 큐에 저장
      const now = Date.now();

      // 오프라인 메시지도 읽지 않은 메시지 수 증가
      const unreadCount = incrementUnreadCount(toGroup, fromId);
      receivedData.unreadCount = unreadCount;

      toGroup.temp_queue.push({
        msg: receivedData,
        timestamp: now,
        ttl: now + MESSAGE_TTL
      });
      console.log(`📦 큐 저장: ${fromId} -> ${toId} (오프라인, 읽지않음: ${unreadCount}, TTL: ${MESSAGE_TTL / 1000}초)`);

      // TODO: FCM Push Notification 전송
      // sendPushNotification(toId, { from: fromId, text });

      socket.emit('queued', { message: "상대방이 오프라인입니다. 메시지가 큐에 저장되었습니다." });
    }
  });

  // ⑥ 메시지 읽음 처리 (mark_as_read)
  socket.on('mark_as_read', (fromId) => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);

    if (!group || !fromId) return;

    // 읽지 않은 메시지 수 초기화
    resetUnreadCount(group, fromId);

    // 같은 그룹의 모든 기기에 읽음 처리 동기화
    const readNotification = {
      type: 'read_receipt',
      fromId: fromId,
      readBy: hardwareId,
      timestamp: getTimestamp()
    };

    broadcastToGroup(group, readNotification);
    console.log(`✅ 읽음 처리: ${hardwareId}가 ${fromId}의 메시지 읽음`);
  });

  // ⑦ 읽지 않은 메시지 수 조회 (get_unread_counts)
  socket.on('get_unread_counts', () => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);

    if (!group) {
      socket.emit('unread_counts', {});
      return;
    }

    const counts = getUnreadCounts(group);
    socket.emit('unread_counts', counts);
    console.log(`📊 읽지않은 메시지 조회 [${hardwareId}]:`, counts);
  });

  // 연결 종료 처리
  socket.on('disconnect', () => {
    const hardwareId = socketToId.get(socket.id);
    if (!hardwareId) return;

    const group = groups.get(hardwareId);
    if (!group) return;

    if (group.master === socket.id) {
      console.log(`🔌 Master 연결 종료: ${hardwareId}`);
      // 🔥 Presence Tracking: 오프라인 상태로 변경
      group.master = null;
      group.isOnline = false;

      // 만료된 큐 아이템 정리
      const removed = cleanExpiredMessages(group);
      if (removed > 0) {
        console.log(`🗑️ 만료 메시지 삭제: ${removed}개 (남은: ${group.temp_queue.length}개)`);
      }
    } else {
      group.slaves.delete(socket.id);
      console.log(`🔌 Slave 연결 종료: ${socket.id} (Group ${hardwareId})`);
    }

    socketToId.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Simple_chat Master-Group Router running on port ${PORT}`);
  console.log(`🛡️ Hardware-ID Based, Zero Persistence, Real-time Relay.`);
  console.log(`📦 Offline Queue System: TTL ${MESSAGE_TTL / 1000}s`);
  console.log(`🧹 Auto-cleanup interval: ${CLEANUP_INTERVAL / 1000}s`);
});