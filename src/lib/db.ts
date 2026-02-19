import pg from 'pg';
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://admin:password@localhost:5432/transparent_pipeline';

// Mask password in connection log
const maskedUrl = connectionString.replace(/:[^:@]+@/, ':****@');
console.log(`📡 [Postgres] Connecting to: ${maskedUrl}`);

const pool = new Pool({
    connectionString
});

// Auto-initialize schema
export const initDb = async () => {
    console.log('🚀 [Postgres] Initializing schema...');

    // 1. Create Tables
    const tables = [
        `CREATE TABLE IF NOT EXISTS accounts (
            account_uuid VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            account_salt VARCHAR(255) NOT NULL,
            kdf_params JSONB NOT NULL,
            dh_public_key TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY,
            user_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
            friend_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
            status VARCHAR(50) DEFAULT 'accepted',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_uuid, friend_uuid)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_uuid)`,
        `CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_uuid)`
    ];

    for (const sql of tables) {
        try {
            await pool.query(sql);
        } catch (err) {
            console.error('❌ [Postgres] Schema init error on query:', sql, err);
            throw err;
        }
    }

    // 2. Migrations (Add columns if missing for existing tables)
    try {
        await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dh_public_key TEXT;`);
        console.log('✅ [Postgres] Checked/Added dh_public_key column');
    } catch (e) {
        console.warn('⚠️ [Postgres] check dh_public_key error (safe to ignore if exists):', e);
    }

    console.log('✅ [Postgres] Schema initialized successfully');
};

export default pool;
