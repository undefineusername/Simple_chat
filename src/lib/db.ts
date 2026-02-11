import { Pool } from 'pg';

console.log(`📡 [Postgres] Connecting to: ${process.env.DATABASE_URL || 'default transparent_pipeline'}`);
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://admin:password@localhost:5432/transparent_pipeline'
});

export default pool;
