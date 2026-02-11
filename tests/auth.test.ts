import { describe, test, expect, afterAll } from '@jest/globals';
import { Auth } from '../src/lib/auth.js';
import pool from '../src/lib/db.js';

describe('Auth Layer', () => {
    afterAll(async () => {
        await pool.end();
    });

    test('Auth: register and exists', async () => {
        const uuid = 'test-uuid-' + Date.now();
        await Auth.register(uuid, 'salt', { alg: 'argon2id' });

        expect(await Auth.exists(uuid)).toBe(true);
        const account = await Auth.getAccount(uuid);
        expect(account.account_uuid).toBe(uuid);
    });
});
