import { Redis } from 'ioredis';

const isDefault = !process.env.REDIS_URL && !process.env.REDIS_PRIVATE_URL && !process.env.REDISHOST;
const redisUrl = process.env.REDIS_URL ||
    process.env.REDIS_PRIVATE_URL ||
    (process.env.REDISHOST ? `redis://:${process.env.REDISPASSWORD}@${process.env.REDISHOST}:${process.env.REDISPORT}` : 'redis://localhost:6379');

// Mask password in connection log
const maskedUrl = redisUrl.replace(/:[^:@]+@/, ':****@');
console.log(`📡 [Redis] Connecting to: ${maskedUrl} ${isDefault ? '⚠️ (FALLBACK TO LOCALHOST)' : '✅ (REMOTE)'}`);

if (isDefault && process.env.NODE_ENV === 'production') {
    console.error('❌ [CRITICAL] REDIS_URL is missing in PRODUCTION environment!');
}

const isTls = redisUrl.startsWith('rediss://');

const redisOptions: any = {
    maxRetriesPerRequest: null,
    connectTimeout: 10000, // 10s timeout
};

if (isTls) {
    redisOptions.tls = { rejectUnauthorized: false };
}

const redis = new Redis(redisUrl, redisOptions);

redis.on('error', (err: any) => {
    console.error('🔴 [Redis] Error:', err.message || err);
    if (err.stack) console.error(err.stack);
});


const QUEUE_TTL_SEC = 30 * 60; // 30 minutes

export const PresenceStore = {
    async setOnline(uuid: string, socketId: string) {
        await redis.sadd('online_users', uuid);
        await redis.set(`presence:${uuid}`, socketId, 'EX', 3600); // 1 hour buffer
    },

    async setOffline(uuid: string) {
        await redis.srem('online_users', uuid);
        await redis.del(`presence:${uuid}`);
    },

    async isOnline(uuid: string): Promise<boolean> {
        return (await redis.sismember('online_users', uuid)) === 1;
    },

    async getSocketId(uuid: string): Promise<string | null> {
        return await redis.get(`presence:${uuid}`);
    }
};

export const MessageQueue = {
    async push(recipientUuid: string, payload: any) {
        const key = `queue:${recipientUuid}`;
        const data = JSON.stringify({
            ...payload,
            expiresAt: Date.now() + (QUEUE_TTL_SEC * 1000)
        });

        await redis.rpush(key, data);
        await redis.expire(key, QUEUE_TTL_SEC);
    },

    async flush(recipientUuid: string): Promise<any[]> {
        const key = `queue:${recipientUuid}`;
        const messages = await redis.lrange(key, 0, -1);
        await redis.del(key);

        return messages.map((m: string) => JSON.parse(m));
    }
};

export const CallStore = {
    async joinCall(groupId: string, uuid: string) {
        const key = `call:${groupId}:participants`;
        await redis.sadd(key, uuid);
        await redis.expire(key, 3600); // 1 hour TTL for safety
    },

    async leaveCall(groupId: string, uuid: string) {
        const key = `call:${groupId}:participants`;
        await redis.srem(key, uuid);
        // If no more participants, the key will eventually expire
    },

    async getParticipants(groupId: string): Promise<string[]> {
        const key = `call:${groupId}:participants`;
        return await redis.smembers(key);
    },

    async clearUserFromAllCalls(uuid: string): Promise<string[]> {
        // This is a bit expensive if there are many active calls,
        // but for this scale it's fine.
        // Returns the list of groupIds the user was removed from.
        const keys = await redis.keys('call:*:participants');
        const removedGroups: string[] = [];

        for (const key of keys) {
            const isMember = await redis.sismember(key, uuid);
            if (isMember) {
                await redis.srem(key, uuid);
                // Extract groupId from key "call:{groupId}:participants"
                const parts = key.split(':');
                if (parts.length >= 3 && parts[1]) {
                    removedGroups.push(parts[1]);
                }
            }
        }
        return removedGroups;
    }
};

export default redis;
