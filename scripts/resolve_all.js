import { query } from '../src/db/neon.js';

async function run() {
    try {
        console.log("Resolving all active incidents...");
        const result = await query(`
            UPDATE system_incidents 
            SET status = 'resolved' 
            WHERE status != 'resolved' RETURNING *;
        `);
        console.log(`✅ Update Complete. Resolved ${result.rowCount} incidents.`);
        process.exit(0);
    } catch (e) {
        console.error("❌ Failed:", e);
        process.exit(1);
    }
}

run();
