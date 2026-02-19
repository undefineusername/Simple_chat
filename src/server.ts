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
import { initDb } from './lib/db.js';

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
        try {
            const account = await Auth.getSaltByUsername(username);
            if (account) {
                socket.emit('salt_found', {
                    uuid: account.account_uuid,
                    salt: account.account_salt,
                    kdfParams: account.kdf_params,
                    publicKey: account.dh_public_key // Send Public Key
                });
            } else {
                socket.emit('salt_not_found');
            }
        } catch (err) {
            console.error('❌ [Auth] Error in get_salt:', err);
            socket.emit('salt_not_found');
        }
    });

    // Invite Code System
    socket.on('create_invite_code', async () => {
        const uuid = socketToUuid.get(socket.id);
        if (!uuid) return socket.emit('error_msg', { message: 'Unauthorized' });

        try {
            // Generate 6-char Alphanumeric Code
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();

            // Get public key if available (Optional, mainly just need UUID to find friend)
            // But having public key directly speeds up 'add friend'
            // We can retrieve it from DB or Auth if needed, or rely on client sending it?
            // Client didn't send it in this event. 
            // We can fetch user details from Auth/DB
            const account = await Auth.getAccount(uuid);
            // We need a helper to get public key if stored? 
            // Currently Auth.getSaltByUsername returns minimal info.
            // Let's just store UUID and Username for now, client can fetch Salt/Key via get_salt logic later if needed
            // OR we can make 'resolve_invite_code' equivalent to 'salt_found'

            // Store in Redis (24h TTL)
            await redis.set(`invite:${code}`, JSON.stringify({
                uuid,
                username: account?.username || 'Unknown'
            }), 'EX', 86400);

            socket.emit('invite_code_created', { code, expiresAt: Date.now() + 86400000 });
            console.log(`🎟️ [Invite] Created code ${code} for ${uuid}`);
        } catch (e) {
            console.error('Failed to create invite code', e);
        }
    });

    socket.on('resolve_invite_code', async (code: string) => {
        if (!code) return;
        try {
            const dataStr = await redis.get(`invite:${code.toUpperCase()}`);
            if (dataStr) {
                const data = JSON.parse(dataStr);
                // We typically need salt/params for the full 'add friend' flow if we want to do it properly?
                // Or we just return UUID and client calls get_salt? 
                // Let's return UUID and Username. Client can then use UUID or Username to proceed.
                // Actually, to add friend securely, we might need their public key if we want to skip handshake?
                // For now, let's just return what we stored.

                // Better: Return the same data as 'salt_found' if possible?
                // Let's look up the account again to be sure we have latest params.
                const account = await Auth.getAccount(data.uuid);

                if (account) {
                    socket.emit('invite_code_resolved', {
                        uuid: account.account_uuid,
                        username: account.username,
                        salt: account.account_salt,
                        kdfParams: account.kdf_params
                    });
                } else {
                    socket.emit('invite_code_error', { message: 'User not found' });
                }
            } else {
                socket.emit('invite_code_error', { message: 'Invalid or expired code' });
            }
        } catch (e) {
            console.error('Error resolving invite code', e);
            socket.emit('invite_code_error', { message: 'Server error' });
        }
    });


    // Register Master (Login/Connect/Signup)
    socket.on('register_master', async (event: RegisterMasterEvent & { publicKey?: any }) => {
        const { uuid, username, salt, kdfParams, publicKey } = event;

        // Auto-Signup if details provided
        if (username && salt && kdfParams) {
            const result = await Auth.register(uuid, username, salt, kdfParams, publicKey);
            if (!result.success) {
                if (result.reason === 'USERNAME_TAKEN') {
                    return socket.emit('error_msg', { message: 'Username already taken. Please choose another one.' });
                }
                return socket.emit('error_msg', { message: 'Registration failed due to server error.' });
            }
        } else if (uuid && publicKey) {
            // Update Public Key for existing users connecting without full registration details
            await Auth.updatePublicKey(uuid, publicKey);
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

    socket.on('get_presence', async (targetUuid: string) => {
        if (!targetUuid) return;
        const online = await PresenceStore.isOnline(targetUuid);
        socket.emit('presence_update', { uuid: targetUuid, status: online ? 'online' : 'offline' });
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

        // Init DB Schema
        await initDb();

        server.listen(PORT, () => {
            console.log(`🚀 [Transparent Pipeline] Running on port ${PORT}`);
        });
    } catch (error) {
        console.error('❌ [Critical] Failed to start server:', error);
        process.exit(1);
    }
};

startServer();

