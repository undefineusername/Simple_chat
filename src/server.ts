import http from 'http';
import express from 'express';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { PresenceStore, MessageQueue } from './lib/redis.js';
import { Auth } from './lib/auth.js';
import { Social } from './lib/social.js';
import type { RelayPayload, RegisterMasterEvent } from './types/protocol.js';
import { createAdapter } from '@socket.io/redis-adapter';
import redis from './lib/redis.js';

const app = express();
app.use(cors());

// Diagnostic: Check environment variables
console.log('🧐 [Diagnostic] Checking Environment Variables:');
console.log(' - REDIS_URL:', process.env.REDIS_URL ? '✅ Found' : '❌ Missing');
console.log(' - REDISHOST:', process.env.REDISHOST ? '✅ Found' : '❌ Missing');
console.log(' - DATABASE_URL:', process.env.DATABASE_URL ? '✅ Found' : '❌ Missing');
console.log(' - PORT:', process.env.PORT || '3000 (default)');

// Health Check
app.get('/ping', (req, res) => res.send('pong'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e7 // 10MB limit
});

// Horizontal Scaling via Redis Pub/Sub
const pubClient = redis;
const subClient = redis.duplicate();

subClient.on('error', (err: any) => {
    console.error('🔴 [Redis Sub] Error:', err.message || err);
});

io.adapter(createAdapter(pubClient, subClient));

const socketToUuid = new Map<string, string>();

/**
 * Metadata-only logging
 */
const logMetadata = (sender: string, recipient: string, size: number) => {
    console.log(JSON.stringify({
        event: 'relay',
        sender_uuid: sender,
        recipient_uuid: recipient,
        timestamp: new Date().toISOString(),
        payload_size: size
    }));
};

/**
 * Rate Limiting (Simple Token Bucket per Socket)
 */
const rateLimits = new Map<string, { tokens: number, lastRefill: number }>();
const MAX_TOKENS = 100;
const REFILL_RATE = 10; // 10 tokens per second

const checkRateLimit = (socketId: string) => {
    const now = Date.now();
    let limit = rateLimits.get(socketId) || { tokens: MAX_TOKENS, lastRefill: now };

    const elapsed = (now - limit.lastRefill) / 1000;
    limit.tokens = Math.min(MAX_TOKENS, limit.tokens + elapsed * REFILL_RATE);
    limit.lastRefill = now;

    if (limit.tokens >= 1) {
        limit.tokens -= 1;
        rateLimits.set(socketId, limit);
        return true;
    }
    return false;
};

io.on('connection', (socket: Socket) => {
    console.log(`🔌 [Connected] ${socket.id}`);

    // Discovery: Fetch Salt for a username
    socket.on('get_salt', async (username: string) => {
        if (!username) return;
        const account = await Auth.getSaltByUsername(username);
        if (account) {
            socket.emit('salt_found', {
                uuid: account.account_uuid,
                salt: account.account_salt,
                kdfParams: account.kdf_params
            });
        } else {
            socket.emit('salt_not_found');
        }
    });

    // Register Master (Login/Connect/Signup)
    socket.on('register_master', async (event: RegisterMasterEvent) => {
        const { uuid, username, salt, kdfParams } = event;

        // Auto-Signup if details provided
        if (username && salt && kdfParams) {
            await Auth.register(uuid, username, salt, kdfParams);
        }

        if (!uuid || !(await Auth.exists(uuid))) {
            return socket.emit('error_msg', { message: 'Invalid UUID or Unauthorized' });
        }

        socketToUuid.set(socket.id, uuid);
        await PresenceStore.setOnline(uuid, socket.id);

        socket.emit('registered', { type: 'master', uuid });

        // Flush offline queue
        const pending = await MessageQueue.flush(uuid);
        if (pending.length > 0) {
            socket.emit('queue_flush', pending);
            console.log(`📦 [Queue] Flushed ${pending.length} items to ${uuid}`);
        }
    });

    // Zero-Knowledge Binary Relay
    socket.on('relay', async (data: RelayPayload) => {
        const senderUuid = socketToUuid.get(socket.id);
        if (!senderUuid || !data.to || data.payload === undefined) return;

        if (!checkRateLimit(socket.id)) {
            return socket.emit('error_msg', { message: 'Rate limit exceeded' });
        }

        const payloadSize = Buffer.isBuffer(data.payload) ? data.payload.length :
            (typeof data.payload === 'string' ? Buffer.byteLength(data.payload) : JSON.stringify(data.payload).length);

        // Logging only metadata
        logMetadata(senderUuid, data.to, payloadSize);

        const relayData: RelayPayload = {
            msgId: data.msgId, // Tracked ID
            from: senderUuid,
            to: data.to,
            payload: data.payload, // Immutable Buffer/Uint8Array
            timestamp: Date.now()
        };

        const recipientSocketId = await PresenceStore.getSocketId(data.to);

        if (recipientSocketId && io.sockets.sockets.has(recipientSocketId)) {
            io.to(recipientSocketId).emit('relay_push', relayData);
            socket.emit('dispatch_status', { to: data.to, msgId: data.msgId, status: 'delivered' });
        } else {
            // Ephemeral Queuing (30m TTL in Redis)
            await MessageQueue.push(data.to, relayData);
            socket.emit('dispatch_status', { to: data.to, msgId: data.msgId, status: 'queued' });
        }
    });

    // Message ACK (Recipient -> Server -> Sender)
    socket.on('msg_ack', async (data: { to: string, msgId: string }) => {
        const senderUuid = socketToUuid.get(socket.id);
        if (!senderUuid || !data.to || !data.msgId) return;

        const recipientSocketId = await PresenceStore.getSocketId(data.to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('msg_ack_push', {
                from: senderUuid,
                msgId: data.msgId
            });
        }
    });

    // Social Safety
    socket.on('block_user', async (targetUuid: string) => {
        const uuid = socketToUuid.get(socket.id);
        if (uuid) {
            await Social.block(uuid, targetUuid);
            socket.emit('blocked', { targetUuid });
        }
    });

    socket.on('report_user', async ({ targetUuid, reason }: { targetUuid: string, reason: string }) => {
        const uuid = socketToUuid.get(socket.id);
        if (uuid) {
            await Social.report(uuid, targetUuid, reason);
            socket.emit('reported', { targetUuid });
        }
    });

    socket.on('disconnect', async () => {
        const uuid = socketToUuid.get(socket.id);
        if (uuid) {
            await PresenceStore.setOffline(uuid);
            socketToUuid.delete(socket.id);
        }
        rateLimits.delete(socket.id);
        console.log(`👋 [Disconnected] ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const startServer = async () => {
    try {
        // Check Redis connection
        await redis.ping();
        console.log('✅ [Redis] Connected');

        server.listen(PORT, () => {
            console.log(`🚀 [Transparent Pipeline] Running on port ${PORT}`);
        });
    } catch (error) {
        console.error('❌ [Critical] Failed to start server:', error);
        process.exit(1);
    }
};

startServer();

