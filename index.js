const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

/**
 * [Transparent Pipeline v2.1] - Pure Stateless Relay + Tunnel Queue
 * 1. No Database: All data is transient (RAM-only).
 * 2. Raw Relay: Dumb pipe acting as a delivery agent for binary/JSON/text.
 * 3. Tunnel Queue: Short-term buffer (30m) for offline recipients.
 * 4. Auto-Flush: Delivers missed messages immediately upon registration.
 */

const app = express();
app.use(cors());

// Health Check
app.get('/ping', (req, res) => res.send('pong'));

// 정적 파일 서빙: test.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});


const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7 // 10MB limit
});

// 인메모리 저장소
const groups = new Map(); // hardwareId -> { master: socketId, slaves: Set<socketId>, syncCode, expires }
const socketToId = new Map(); // socketId -> hardwareId
const syncCodes = new Map(); // code -> hardwareId
const offlineQueues = new Map(); // hardwareId -> Array<{ payload, expiresAt }>

// 설정값
const MAX_PAYLOAD_SIZE = 1024 * 1024 * 5; // 5MB
const QUEUE_TTL = 30 * 60 * 1000; // 30분 보관
const MAX_QUEUE_SIZE = 100; // 사용자당 최대 100개 메시지 큐잉
const SYNC_CODE_TTL = 5 * 60 * 1000; // 5분
const CLEANUP_INTERVAL = 60 * 1000; // 1분

/**
 * 헬퍼: 큐에 메시지 쌓기 (오프라인 보관)
 */
const pushToQueue = (targetHwId, payload) => {
  if (!offlineQueues.has(targetHwId)) {
    offlineQueues.set(targetHwId, []);
  }
  const queue = offlineQueues.get(targetHwId);

  if (queue.length < MAX_QUEUE_SIZE) {
    queue.push({
      payload,
      expiresAt: Date.now() + QUEUE_TTL
    });
    return true;
  }
  return false;
};

/**
 * 헬퍼: 쌓여있던 큐 비우기 (접속 시 배달)
 */
const flushQueue = (socket, hardwareId) => {
  const pending = offlineQueues.get(hardwareId);
  if (pending && pending.length > 0) {
    socket.emit('queue_flush', pending.map(item => item.payload));
    offlineQueues.delete(hardwareId);
    console.log(`📦 [Queue] Flushed ${pending.length} items to ${hardwareId}`);
  }
};

/**
 * 헬퍼: 그룹 전체에 데이터 전파
 */
const relayToGroup = (targetHwId, event, data, excludeSocketId = null) => {
  const group = groups.get(targetHwId);
  if (!group || (!group.master && group.slaves.size === 0)) return false;

  const targets = [];
  if (group.master) targets.push(group.master);
  group.slaves.forEach(sid => targets.push(sid));

  let sentCount = 0;
  targets.forEach(sid => {
    if (sid !== excludeSocketId) {
      io.to(sid).emit(event, data);
      sentCount++;
    }
  });
  return sentCount > 0;
};

// 주기적 정리 (만료된 큐 & 코드)
setInterval(() => {
  const now = Date.now();

  // 1. 만료된 큐 삭제
  for (const [hwId, queue] of offlineQueues.entries()) {
    const validItems = queue.filter(item => item.expiresAt > now);
    if (validItems.length === 0) {
      offlineQueues.delete(hwId);
    } else {
      offlineQueues.set(hwId, validItems);
    }
  }

  // 2. 만료된 연동 코드 삭제
  for (const [code, hardwareId] of syncCodes.entries()) {
    const group = groups.get(hardwareId);
    if (!group || (group.expires && group.expires < now)) {
      syncCodes.delete(code);
      if (group) { group.syncCode = null; group.expires = null; }
    }
  }
}, CLEANUP_INTERVAL);

io.on('connection', (socket) => {
  console.log(`🔌 [Connected] ${socket.id}`);

  // ① Master 등록 및 큐 확인
  socket.on('register_master', (hardwareId) => {
    if (!hardwareId || typeof hardwareId !== 'string') return;

    if (!groups.has(hardwareId)) {
      groups.set(hardwareId, { master: socket.id, slaves: new Set(), syncCode: null, expires: null });
    } else {
      groups.get(hardwareId).master = socket.id;
    }

    socketToId.set(socket.id, hardwareId);
    socket.emit('registered', { type: 'master', hardwareId });

    // 쌓인 큐가 있다면 배달
    flushQueue(socket, hardwareId);
    console.log(`📱 [Master] ${hardwareId} online`);
  });

  /**
   * ② PC 연동 코드 요청 (Sync Secret)
   */
  socket.on('request_sync_code', () => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);
    if (!group || group.master !== socket.id) return;

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    if (group.syncCode) syncCodes.delete(group.syncCode);

    group.syncCode = code;
    group.expires = Date.now() + SYNC_CODE_TTL;
    syncCodes.set(code, hardwareId);

    socket.emit('sync_code', { code, expires: group.expires });
  });

  // ③ Slave 연동 및 큐 확인
  socket.on('link_pc', (code) => {
    const hardwareId = syncCodes.get(code);
    const group = groups.get(hardwareId);

    if (group && group.expires > Date.now()) {
      group.slaves.add(socket.id);
      socketToId.set(socket.id, hardwareId);
      socket.emit('registered', { type: 'slave', hardwareId });

      if (group.master) io.to(group.master).emit('slave_linked', { slaveId: socket.id });

      flushQueue(socket, hardwareId);
      console.log(`💻 [Slave] linked to ${hardwareId}`);
    } else {
      socket.emit('error_msg', { message: "유효하지 않거나 만료된 코드입니다." });
    }
  });

  // ④ 투명한 파이프라인 + 오프라인 큐잉
  socket.on('raw_relay', ({ toId, data }) => {
    const fromId = socketToId.get(socket.id);
    if (!fromId || !toId || data === undefined) return;

    // 페이로드 크기 검사
    const payloadSize = Buffer.isBuffer(data) ? data.length :
      (typeof data === 'string' ? Buffer.byteLength(data) : JSON.stringify(data).length);
    if (payloadSize > MAX_PAYLOAD_SIZE) return socket.emit('error_msg', { message: "Data too large" });

    const relayPayload = { from: fromId, to: toId, payload: data, timestamp: Date.now() };

    // 1. 실시간 전달 시도
    const delivered = relayToGroup(toId, 'raw_push', relayPayload);

    // 2. 전달 실패 시 큐에 저장 (오프라인 보관)
    if (!delivered) {
      const queued = pushToQueue(toId, relayPayload);
      socket.emit('dispatch_status', { toId, status: queued ? 'queued' : 'dropped' });
    } else {
      socket.emit('dispatch_status', { toId, status: 'delivered' });
    }

    // 3. 내 다른 기기로 동기화 (Echo)
    relayToGroup(fromId, 'raw_push', { ...relayPayload, type: 'echo' }, socket.id);
  });

  // Legacy Compatibility (test.html 지원용)
  socket.on('direct_message', ({ toId, text }) => {
    const fromId = socketToId.get(socket.id);
    if (!fromId) return;
    const payload = { from: fromId, to: toId, payload: { type: 'text', content: text }, timestamp: Date.now() };

    if (!relayToGroup(toId, 'push', { from: fromId, text, type: 'received' })) {
      pushToQueue(toId, payload);
    }
    relayToGroup(fromId, 'push', { from: fromId, text, type: 'sent' }, socket.id);
  });

  socket.on('mark_as_read', (targetId) => {
    handleLegacyRelay(socket, targetId, { type: 'ack', action: 'read' });
  });

  function handleLegacyRelay(sock, toId, data) {
    const fromId = socketToId.get(sock.id);
    if (!fromId) return;

    const payload = { from: fromId, to: toId, payload: data, timestamp: Date.now() };

    // Legacy push event for consistency with old HTML
    relayToGroup(toId, 'push', { from: fromId, text: data.content || data.action, type: data.type });
    relayToGroup(fromId, 'push', { from: fromId, text: data.content || data.action, type: 'sent' }, sock.id);
  }

  socket.on('disconnect', () => {
    const hardwareId = socketToId.get(socket.id);
    if (hardwareId) {
      const group = groups.get(hardwareId);
      if (group) {
        if (group.master === socket.id) group.master = null;
        else group.slaves.delete(socket.id);
      }
      socketToId.delete(socket.id);
    }
    console.log(`👋 [Disconnected] ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.clear();
  console.log(`
  ================================================
     🛡️  TRANSPARENT PIPELINE RELAY v2.1  🛡️
  ================================================
     Status: Running on port ${PORT}
     Mode: Stateless + Tunnel Queue (30m)
     Max Queue: 100 items / User
  ================================================
  `);
});
