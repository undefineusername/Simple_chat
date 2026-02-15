import argon2 from 'argon2';
import pool from './db.js';

export const Auth = {
    async updatePublicKey(uuid: string, publicKey: any) {
        const query = 'UPDATE accounts SET dh_public_key = $2 WHERE account_uuid = $1';
        try {
            await pool.query(query, [uuid, publicKey]);
        } catch (e) {
            console.error("Failed to update public key", e);
        }
    },

    async register(uuid: string, username: string, salt: string, kdfParams: any, publicKey?: any): Promise<{ success: boolean; reason?: 'USERNAME_TAKEN' | 'DB_ERROR' }> {
        // Check if username already taken by a different UUID
        const checkQuery = 'SELECT account_uuid FROM accounts WHERE username = $1';
        const checkRes = await pool.query(checkQuery, [username]);
        if (checkRes.rowCount && checkRes.rows[0].account_uuid !== uuid) {
            console.warn(`⚠️ [Auth] Username ${username} already taken.`);
            return { success: false, reason: 'USERNAME_TAKEN' };
        }

        const query = `
      INSERT INTO accounts (account_uuid, username, account_salt, kdf_params, dh_public_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_uuid) DO UPDATE
      SET dh_public_key = EXCLUDED.dh_public_key
      RETURNING *;
    `;
        try {
            await pool.query(query, [uuid, username, salt, kdfParams, publicKey]);
            return { success: true };
        } catch (e) {
            console.error("DB Register Error", e);
            return { success: false, reason: 'DB_ERROR' };
        }
    },

    async getSaltByUsername(username: string) {
        const query = 'SELECT account_uuid, account_salt, kdf_params, dh_public_key FROM accounts WHERE username = $1';
        const res = await pool.query(query, [username]);
        return res.rows[0];
    },

    async exists(uuid: string): Promise<boolean> {
        const query = 'SELECT 1 FROM accounts WHERE account_uuid = $1';
        const res = await pool.query(query, [uuid]);
        return (res.rowCount ?? 0) > 0;
    },

    async getAccount(uuid: string) {
        const query = 'SELECT * FROM accounts WHERE account_uuid = $1';
        const res = await pool.query(query, [uuid]);
        return res.rows[0];
    }
};

/**
 * Note: The client performs the heavy Argon2 hashing.
 * The server only verifies if it exists or stores the salt/params.
 * For "Proof of Ownership", the client can sign a challenge or send a hash of the UUID + Secret.
 */
export const ProofOfOwnership = {
    async verify(uuid: string, proof: string, challenge: string): Promise<boolean> {
        const account = await Auth.getAccount(uuid);
        if (!account) return false;

        // In a pure zero-knowledge setup, the server might just check if the proof 
        // matches the stored hash (if we stored a verifier).
        // The prompt says "The server performs 'Existence Checks' only."
        // But for actual security, we should have some verification.
        return true; // Simple existence check for now as per prompt
    }
};
