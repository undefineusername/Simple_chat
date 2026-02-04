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
 *    master: socketId, 
 *    slaves: Set<socketId>, 
 *    syncCode: string|null, 
 *    expires: number|null 
 * }>
 * socketToId: Map<socketId, hardwareId>
 * syncCodes: Map<code, hardwareId>
 */
const groups = new Map();
const socketToId = new Map();
const syncCodes = new Map();

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
        expires: null
      });
    } else {
      const group = groups.get(hardwareId);
      group.master = socket.id; // 기존 마스터 세션 갱신
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

  // ④ 스마트 데이터 토스 (message_relay) - 그룹 내 모든 기기에 브로드캐스트
  socket.on('message_relay', (payload) => {
    const hardwareId = socketToId.get(socket.id);
    const group = groups.get(hardwareId);

    if (group) {
      const targetMessage = {
        ...payload,
        timestamp: new Date().toISOString()
      };

      // 마스터에게 전송
      io.to(group.master).emit('push', targetMessage);

      // 모든 슬레이브에게 전송
      group.slaves.forEach(slaveId => {
        io.to(slaveId).emit('push', targetMessage);
      });

      console.log(`📡 Relay [Group ${hardwareId}]: ${socket.id} -> All Devices`);
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
        // 마스터 종료 시 그룹 전체를 해제하거나 마스터만 비움
        // 설계에 따라 다르지만 정석대로라면 그룹 유지는 하되 마스터만 undefined
        group.master = null;
      } else {
        group.slaves.delete(socket.id);
        console.log(`🔌 Slave 연결 종료: ${socket.id} (Group ${hardwareId})`);
      }
    }
    socketToId.delete(socket.id);
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`🚀 Simple_chat Master-Group Router running on port ${PORT}`);
  console.log(`🛡️ Hardware-ID Based, Zero Persistence, Real-time Relay.`);
});