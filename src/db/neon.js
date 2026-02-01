import pg from 'pg';
const { Pool } = pg;

// Use POOLED connection for serverless environment efficiency
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let pool;

if (connectionString) {
  pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });
  console.log("🔌 Connected to Neon DB");
} else {
  console.warn("⚠️ Neon DB credentials missing. Logs will be skipped.");
}

export const query = async (text, params) => {
  if (!pool) return null;
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // Optional: console.log('executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Neon Query Error:', error);
    throw error;
  }
};

export const createLogTable = async () => {
  if (!pool) return;
  const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ai_execution_logs (
        id SERIAL PRIMARY KEY,
        trigger_id TEXT,
        input_text TEXT,
        output_text TEXT,
        trigger_source TEXT,
        model TEXT,
        tokens INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
  await query(createTableQuery);

  const createIncidentsQuery = `
      CREATE TABLE IF NOT EXISTS system_incidents (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'investigating', -- investigating, identified, monitoring, resolved
        severity TEXT DEFAULT 'minor', -- minor, major, critical, maintenance
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
  await query(createIncidentsQuery);

  try {
    // Migration: Add affected_service column if missing
    await query(`ALTER TABLE system_incidents ADD COLUMN IF NOT EXISTS affected_service TEXT DEFAULT 'all'`);
  } catch (e) {
    console.log("Migration Note: affected_service column might already exist or DB does not support IF NOT EXISTS. Skipping.");
  }
};

// Auto-init table on module load (safe idempotent check)
// Auto-init table on module load (safe idempotent check)
// Catch errors to prevent crashing the entire app if DB is unreachable
createLogTable().catch(err => console.error("⚠️ Failed to init Neon table:", err.message));

export default pool;
