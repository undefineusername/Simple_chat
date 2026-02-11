import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
});

redis.on('error', (err: Error) => {
    console.error('🔴 [Redis] Error:', err.message);
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

export default redis;
