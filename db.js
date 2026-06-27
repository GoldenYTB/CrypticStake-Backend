import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      wallet          TEXT PRIMARY KEY,
      telegram_id     BIGINT,
      username        TEXT,
      total_staked    DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_rewards   DOUBLE PRECISION NOT NULL DEFAULT 0,
      fees_paid       DOUBLE PRECISION NOT NULL DEFAULT 0,
      banned          BOOLEAN NOT NULL DEFAULT false,
      ban_type        TEXT,
      ban_until       TIMESTAMPTZ,
      ban_reason      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stakes (
      id              SERIAL PRIMARY KEY,
      wallet          TEXT NOT NULL,
      amount_sol      DOUBLE PRECISION NOT NULL,
      amount_usd      DOUBLE PRECISION NOT NULL,
      stake_account   TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      unstaked_at     TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS fees (
      id              SERIAL PRIMARY KEY,
      wallet          TEXT NOT NULL,
      amount_sol      DOUBLE PRECISION NOT NULL,
      fee_pct         DOUBLE PRECISION NOT NULL,
      tx_sig          TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // default settings
  const defaults = [
    ["fee_pct", "5"],
    ["min_stake_usd", "25"],
    ["event_active", "false"],
    ["event_fee_pct", "0"],
    ["event_ends", ""],
    ["event_label", ""],
    ["owner_wallet", process.env.OWNER_WALLET || ""],
  ];
  for (const [key, value] of defaults) {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
      [key, value]
    );
  }
  console.log("CrypticStake DB ready");
}

init().catch((e) => console.error("DB init error:", e));

export async function getSetting(key) {
  const r = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await pool.query(
    "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
    [key, value]
  );
}

export default pool;
