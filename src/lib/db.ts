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
    const schema = `
        CREATE TABLE IF NOT EXISTS accounts (
            account_uuid VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            account_salt VARCHAR(255) NOT NULL,
            kdf_params JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY,
            user_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
            friend_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
            status VARCHAR(50) DEFAULT 'accepted',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_uuid, friend_uuid)
        );

        CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_uuid);
        CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_uuid);
    `;
    try {
        await pool.query(schema);
        console.log('✅ [Postgres] Schema initialized');
    } catch (err) {
        console.error('❌ [Postgres] Schema init error:', err);
    }
};

export default pool;
