const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

/**
 * [Transparent Pipeline] - Pure Statutory Stateless Relay
 * 1. No Database: All data is transient and exists only in memory during transit.
 * 2. Raw Relay: Server acts as a "dumb pipe", not inspecting payload contents.
 * 3. Client Intelligence: Reads, status, and history are managed in local storage.
 * 4. Multi-device Sync: Echoes outgoing data to all devices with the same HardwareID.
 */

const app = express();
app.use(cors());

// 정적 파일 서빙: test.html (Client Interface)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7 // Socket.io layer limit (10MB)
});

// 인메모리 세션 관리 (Transient State)
const groups = new Map(); // hardwareId -> { master: socketId, slaves: Set<socketId>, syncCode: string, expires: number }
const socketToId = new Map(); // socketId -> hardwareId
const syncCodes = new Map(); // code -> hardwareId

// 상수 정의
const MAX_PAYLOAD_SIZE = 1024 * 1024 * 5; // 5MB (Transparent Pipeline policy)
const SYNC_CODE_TTL = 5 * 60 * 1000; // 5분
const CLEANUP_INTERVAL = 60 * 1000; // 1분

/**
 * 헬퍼: 그룹 전체(마스터 + 슬레이브)에 데이터 전파
 */
const relayToGroup = (targetHwId, event, data, excludeSocketId = null) => {
  const group = groups.get(targetHwId);
  if (!group) return false;

  const targets = [];
  if (group.master) targets.push(group.master);
  group.slaves.forEach(sid => targets.push(sid));

  targets.forEach(sid => {
    if (sid !== excludeSocketId) {
      io.to(sid).emit(event, data);
    }
  });
  return targets.length > 0;
};

// 주기적인 만료 데이터 정리 (Sync Codes)
setInterval(() => {
  const now = Date.now();
  for (const [code, hardwareId] of syncCodes.entries()) {
    const group = groups.get(hardwareId);
    if (!group || (group.expires && group.expires < now)) {
      syncCodes.delete(code);
      if (group) {
        group.syncCode = null;
        group.expires = null;
      }
    }
  }
}, CLEANUP_INTERVAL);

io.on('connection', (socket) => {
  console.log(`🔌 [Connected] ${socket.id}`);

  /**
   * ① 기기 등록 (HardwareID 기반)
   */
  socket.on('register_master', (hardwareId) => {
    if (!hardwareId || typeof hardwareId !== 'string') return;

    if (!groups.has(hardwareId)) {
      groups.set(hardwareId, {
        master: socket.id,
        slaves: new Set(),
        syncCode: null,
        expires: null
      });
    } else {
      const group = groups.get(hardwareId);
      group.master = socket.id;
    }

    socketToId.set(socket.id, hardwareId);
    console.log(`📱 [Master] ${hardwareId} linked to ${socket.id}`);
    socket.emit('registered', { type: 'master', hardwareId });
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

  /**
   * ③ PC 연동 실행 (Slave Connection)
   */
  socket.on('link_pc', (code) => {
    const hardwareId = syncCodes.get(code);
    const group = groups.get(hardwareId);

    if (group && group.expires > Date.now()) {
      group.slaves.add(socket.id);
      socketToId.set(socket.id, hardwareId);
      socket.emit('registered', { type: 'slave', hardwareId });

      if (group.master) {
        io.to(group.master).emit('slave_linked', { slaveId: socket.id });
      }
      console.log(`💻 [Slave] linked to ${hardwareId}`);
    } else {
      socket.emit('error_msg', { message: "유효하지 않거나 만료된 코드입니다." });
    }
  });

  /**
   * ④ 투명한 파이프라인 중계 (Transparent Raw Relay)
   * 서버는 데이터를 열어보지 않고 수신자에게 배달만 함.
   */
  socket.on('raw_relay', ({ toId, data }) => {
    const fromId = socketToId.get(socket.id);
    if (!fromId || !toId || data === undefined) return;

    // Payload Size Check (DDoS Protection)
    const payloadSize = Buffer.isBuffer(data) ? data.length :
      (typeof data === 'string' ? Buffer.byteLength(data) : JSON.stringify(data).length);

    if (payloadSize > MAX_PAYLOAD_SIZE) {
      return socket.emit('error_msg', { message: `Payload too large (Max ${MAX_PAYLOAD_SIZE / 1024 / 1024}MB)` });
    }

    const relayPayload = {
      from: fromId,
      to: toId,
      payload: data,
      timestamp: Date.now()
    };

    // 1. 목적지 그룹으로 전송 (Push)
    const delivered = relayToGroup(toId, 'raw_push', relayPayload);

    // 2. 발신자의 다른 기기들로 동기화 (Echo)
    relayToGroup(fromId, 'raw_push', { ...relayPayload, type: 'echo' }, socket.id);

    if (!delivered) {
      socket.emit('dispatch_status', { toId, status: 'offline' });
    }
  });

  /**
   * Legacy Compatibility Layer (For test.html)
   * HTML을 수정하지 않고도 신규 파이프라인 구조를 사용하도록 맵핑
   */
  socket.on('direct_message', ({ toId, text }) => {
    handleLegacyRelay(socket, toId, { type: 'text', content: text });
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

  // 연결 종료 처리
  socket.on('disconnect', () => {
    const hardwareId = socketToId.get(socket.id);
    if (!hardwareId) return;

    const group = groups.get(hardwareId);
    if (group) {
      if (group.master === socket.id) {
        group.master = null;
      } else {
        group.slaves.delete(socket.id);
      }
    }
    socketToId.delete(socket.id);
    console.log(`👋 [Disconnected] ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.clear();
  console.log(`
  ================================================
     �️  TRANSPARENT PIPELINE RELAY ENGINE v2  🛡️
  ================================================
     Status: Running on port ${PORT}
     Mode: Stateless / DB-Free / Raw Data
     Max Payload: ${MAX_PAYLOAD_SIZE / 1024 / 1024}MB
  ================================================
  `);
});

