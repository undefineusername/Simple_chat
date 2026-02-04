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
 *    isOnline: boolean
 * }>
 * socketToId: Map<socketId, hardwareId>
 * syncCodes: Map<code, hardwareId>
 */
const groups = new Map();
const socketToId = new Map();
const syncCodes = new Map();

// 오프라인 메시지 TTL (10분)
const MESSAGE_TTL = 10 * 60 * 1000;

// 인증 코드 생성 함수 (6자리 난수)
function generateSyncCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`🔌 새 연결: ${socket.id}`);

  // ① 마스터 등록 (register_master)
  socket.on('register_master', (hardwareId) => {
    if (!groups.has(hardwareId)) {
      groups.set(hardwareId, {
        master: socket.id,
        slaves: new Set(),
        syncCode: null,
        expires: null,
        temp_queue: [],
        isOnline: true
      });
    } else {
      const group = groups.get(hardwareId);
      group.master = socket.id; // 기존 마스터 세션 갱신
      group.isOnline = true;

      // 🔥 Pull on Connect: 큐에 쌓인 메시지 즉시 플러시
      if (group.temp_queue.length > 0) {
        console.log(`📬 큐 플러시: ${group.temp_queue.length}개 메시지 전송 (${hardwareId})`);

        // TTL 체크 후 유효한 메시지만 전송
        const now = Date.now();
        const validMessages = group.temp_queue.filter(item => now < item.ttl);

        validMessages.forEach(item => {
          io.to(socket.id).emit('push', item.msg);
          // 슬레이브들에게도 전송
          group.slaves.forEach(sid => io.to(sid).emit('push', item.msg));
        });

        // 큐 비우기
        group.temp_queue = [];
        console.log(`✅ 큐 비움 완료 (유효: ${validMessages.length}개)`);
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

    if (group && group.master === socket.id) {
      const code = generateSyncCode();
      const expires = Date.now() + (5 * 60 * 1000); // 5분 유효

      // 이전 코드 제거
      if (group.syncCode) syncCodes.delete(group.syncCode);

      group.syncCode = code;
      group.expires = expires;
      syncCodes.set(code, hardwareId);

      console.log(`🔑 코드 생성 [${hardwareId}]: ${code}`);
      socket.emit('sync_code', { code, expires });
    }
  });

  // ③ 슬레이브 연동 (link_pc)
  socket.on('link_pc', (code) => {
    const hardwareId = syncCodes.get(code);
    const group = groups.get(hardwareId);

    if (group && group.expires > Date.now()) {
      group.slaves.add(socket.id);
      socketToId.set(socket.id, hardwareId);

      console.log(`💻 PC 연동 성공: ${socket.id} -> Group ${hardwareId}`);
      socket.emit('registered', { type: 'slave', hardwareId });

      // 마스터에게도 알림
      io.to(group.master).emit('slave_linked', { slaveId: socket.id });
    } else {
      socket.emit('error_msg', { message: "유효하지 않거나 만료된 코드입니다." });
    }
  });

  // ④ 내부 동기화 (message_relay): 같은 HardwareID 그룹 내 모든 기기(폰+PC)에 전송
  socket.on('message_relay', (payload) => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);
    if (group) {
      const data = { ...payload, from: hardwareId, type: 'sync', timestamp: new Date().toISOString() };
      if (group.master) io.to(group.master).emit('push', data);
      group.slaves.forEach(sid => io.to(sid).emit('push', data));
    }
  });

  // ⑤ 유저 간 채팅 (direct_message): 다른 HardwareID 그룹으로 전송
  socket.on('direct_message', ({ toId, text }) => {
    const fromId = socketToId.get(socket.id);
    if (!fromId) return;

    const fromGroup = groups.get(fromId);
    const toGroup = groups.get(toId);

    const messagePayload = {
      from: fromId,
      to: toId,
      text: text,
      timestamp: new Date().toISOString()
    };

    // 1. 발신자 그룹 전체에 전송 (내가 보낸 메시지 동기화)
    if (fromGroup) {
      const sentData = { ...messagePayload, type: 'sent' };
      if (fromGroup.master) io.to(fromGroup.master).emit('push', sentData);
      fromGroup.slaves.forEach(sid => io.to(sid).emit('push', sentData));
    }

    // 2. 수신자 그룹 전체에 전송
    if (toGroup) {
      const receivedData = { ...messagePayload, type: 'received' };

      // 🔥 Presence Tracking: 온라인 상태 확인
      if (toGroup.isOnline && toGroup.master) {
        // 온라인 → 즉시 전송
        io.to(toGroup.master).emit('push', receivedData);
        toGroup.slaves.forEach(sid => io.to(sid).emit('push', receivedData));
        console.log(`💬 Chat: ${fromId} -> ${toId} (즉시 전송)`);
      } else {
        // 🔥 Dead-Letter Queue: 오프라인 → 큐에 저장
        const queueItem = {
          msg: receivedData,
          timestamp: Date.now(),
          ttl: Date.now() + MESSAGE_TTL
        };
        toGroup.temp_queue.push(queueItem);
        console.log(`📦 큐 저장: ${fromId} -> ${toId} (오프라인, TTL: ${MESSAGE_TTL / 1000}초)`);

        // TODO: FCM Push Notification 전송
        // sendPushNotification(toId, { from: fromId, text });

        socket.emit('queued', { message: "상대방이 오프라인입니다. 메시지가 큐에 저장되었습니다." });
      }
    } else {
      socket.emit('error_msg', { message: "존재하지 않는 사용자입니다." });
    }
  });

  // 연결 종료 처리
  socket.on('disconnect', () => {
    const hardwareId = socketToId.get(socket.id);
    if (!hardwareId) return;

    const group = groups.get(hardwareId);
    if (group) {
      if (group.master === socket.id) {
        console.log(`🔌 Master 연결 종료: ${hardwareId}`);
        // 🔥 Presence Tracking: 오프라인 상태로 변경
        group.master = null;
        group.isOnline = false;

        // 만료된 큐 아이템 정리
        const now = Date.now();
        const beforeCount = group.temp_queue.length;
        group.temp_queue = group.temp_queue.filter(item => now < item.ttl);
        const afterCount = group.temp_queue.length;

        if (beforeCount !== afterCount) {
          console.log(`🗑️ 만료 메시지 삭제: ${beforeCount - afterCount}개 (남은: ${afterCount}개)`);
        }
      } else {
        group.slaves.delete(socket.id);
        console.log(`🔌 Slave 연결 종료: ${socket.id} (Group ${hardwareId})`);
      }
    }
    socketToId.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Simple_chat Master-Group Router running on port ${PORT}`);
  console.log(`🛡️ Hardware-ID Based, Zero Persistence, Real-time Relay.`);
  console.log(`📦 Offline Queue System: TTL ${MESSAGE_TTL / 1000}s`);
});