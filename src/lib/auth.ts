import argon2 from 'argon2';
import pool from './db.js';

export const Auth = {
    async register(uuid: string, username: string, salt: string, kdfParams: any) {
        // Check if username already taken by a different UUID
        const checkQuery = 'SELECT account_uuid FROM accounts WHERE username = $1';
        const checkRes = await pool.query(checkQuery, [username]);
        if (checkRes.rowCount && checkRes.rows[0].account_uuid !== uuid) {
            console.warn(`⚠️ [Auth] Username ${username} already taken.`);
            return null;
        }

        const query = `
      INSERT INTO accounts (account_uuid, username, account_salt, kdf_params)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (account_uuid) DO NOTHING
      RETURNING *;
    `;
        const res = await pool.query(query, [uuid, username, salt, kdfParams]);
        return res.rows[0];
    },

    async getSaltByUsername(username: string) {
        const query = 'SELECT account_uuid, account_salt, kdf_params FROM accounts WHERE username = $1';
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
