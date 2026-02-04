const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// [추가] test.html을 기본 페이지로 제공
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 서버의 유일한 장부: 현재 접속 중인 라우팅 테이블
const routingTable = new Map(); // Key: UUID, Value: SocketID

io.on('connection', (socket) => {
  console.log(`🔌 새 연결: ${socket.id}`);

  // 1. 라우터 등록 (나 여기 접속했어!)
  socket.on('register', (uuid) => {
    routingTable.set(uuid, socket.id);
    console.log(`📡 라우터 등록: ${uuid} -> ${socket.id}`);
    socket.emit('registered', { success: true });
  });

  // 2. 데이터 중계 (나는 데이터 안 봐, 전달만 해)
  socket.on('relay', ({ toUuid, data }) => {
    const targetSocketId = routingTable.get(toUuid);

    if (targetSocketId) {
      io.to(targetSocketId).emit('push', data); // 즉시 전달
      console.log(`➡️ Relay: From ${socket.id} To ${toUuid}`);
    } else {
      console.log(`⚠️ Target Offline: ${toUuid}`);
      socket.emit('error_msg', { message: "대상 유저가 오프라인입니다." });
    }
  });

  // 3. 연결 끊기면 주소록에서 즉시 삭제
  socket.on('disconnect', () => {
    for (let [uuid, id] of routingTable) {
      if (id === socket.id) {
        routingTable.delete(uuid);
        console.log(`🔌 연결 종료 및 라우터 삭제: ${uuid}`);
        break;
      }
    }
  });
});

// [변경] 포트를 80으로 설정 (환경 변수 PORT가 있으면 우선 사용)
const PORT = process.env.PORT || 80;

server.listen(PORT, () => {
  console.log(`🚀 Stateless Relay Server running on port ${PORT}`);
  console.log(`🔗 접속 주소: http://localhost${PORT === 80 ? '' : ':' + PORT}`);
});