import pool from './db.js';

export const Social = {
    async block(userUuid: string, targetUuid: string) {
        const query = `
      INSERT INTO friends (user_uuid, friend_uuid, status)
      VALUES ($1, $2, 'blocked')
      ON CONFLICT (user_uuid, friend_uuid) 
      DO UPDATE SET status = 'blocked';
    `;
        await pool.query(query, [userUuid, targetUuid]);
    },

    async report(reporterUuid: string, reportedUuid: string, reason: string) {
        // In a zero-knowledge system, we can only log that a report happened.
        // We cannot see the content. We log the timestamp and the entities involved.
        console.log(JSON.stringify({
            event: 'report',
            reporter: reporterUuid,
            reported: reportedUuid,
            reason,
            timestamp: new Date().toISOString()
        }));
    },

    async isBlocked(userUuid: string, targetUuid: string): Promise<boolean> {
        const query = `
      SELECT 1 FROM friends 
      WHERE user_uuid = $1 AND friend_uuid = $2 AND status = 'blocked'
    `;
        const res = await pool.query(query, [userUuid, targetUuid]);
        return (res.rowCount ?? 0) > 0;
    }
};
