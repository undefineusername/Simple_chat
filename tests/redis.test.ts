import { describe, test, expect, afterAll } from '@jest/globals';
import { PresenceStore, MessageQueue } from '../src/lib/redis.js';
import redis from '../src/lib/redis.js';

describe('Redis Storage Layer', () => {
    afterAll(async () => {
        await redis.quit();
    });

    test('PresenceStore: setOnline and getSocketId', async () => {
        const uuid = 'user-1';
        const socketId = 'socket-abc';
        await PresenceStore.setOnline(uuid, socketId);

        expect(await PresenceStore.isOnline(uuid)).toBe(true);
        expect(await PresenceStore.getSocketId(uuid)).toBe(socketId);

        await PresenceStore.setOffline(uuid);
        expect(await PresenceStore.isOnline(uuid)).toBe(false);
    });

    test('MessageQueue: push and flush', async () => {
        const uuid = 'user-2';
        const payload = { data: 'hello' };

        await MessageQueue.push(uuid, payload);
        const messages = await MessageQueue.flush(uuid);

        expect(messages.length).toBe(1);
        expect(messages[0].data).toBe('hello');
    });
});
