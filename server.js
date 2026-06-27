import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool, { getSetting, setSetting } from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_SECRET = process.env.ADMIN_SECRET || "change_me";

// ─── auto-lift temp bans ────────────────────────────────────────────────────
async function liftExpiredBans() {
  const r = await pool.query(
    "UPDATE users SET banned=false, ban_type=null, ban_until=null, ban_reason=null WHERE banned=true AND ban_type='temp' AND ban_until <= now() RETURNING wallet"
  );
  if (r.rows.length) console.log(`Lifted ${r.rows.length} temp ban(s)`);
}
setInterval(() => liftExpiredBans().catch(console.error), 60 * 1000);

// ─── PUBLIC: get settings (fee, event) ─────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  const [fee_pct, min_stake_usd, event_active, event_fee_pct, event_ends, event_label] =
    await Promise.all([
      getSetting("fee_pct"), getSetting("min_stake_usd"),
      getSetting("event_active"), getSetting("event_fee_pct"),
      getSetting("event_ends"), getSetting("event_label"),
    ]);

  // auto-expire event
  let eventOn = event_active === "true";
  if (eventOn && event_ends && new Date(event_ends) < new Date()) {
    await setSetting("event_active", "false");
    eventOn = false;
  }

  res.json({
    fee_pct: eventOn ? parseFloat(event_fee_pct) : parseFloat(fee_pct),
    base_fee_pct: parseFloat(fee_pct),
    min_stake_usd: parseFloat(min_stake_usd),
    event_active: eventOn,
    event_fee_pct: parseFloat(event_fee_pct),
    event_ends: event_ends || null,
    event_label: event_label || null,
  });
});

// ─── PUBLIC: register / load user ──────────────────────────────────────────
app.post("/api/user", async (req, res) => {
  const { wallet, telegram_id, username } = req.body;
  if (!wallet) return res.status(400).json({ error: "wallet required" });

  await pool.query(
    `INSERT INTO users (wallet, telegram_id, username, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (wallet) DO UPDATE SET last_seen=now(), telegram_id=COALESCE($2, users.telegram_id), username=COALESCE($3, users.username)`,
    [wallet, telegram_id || null, username || null]
  );

  const u = await pool.query("SELECT * FROM users WHERE wallet = $1", [wallet]);
  const row = u.rows[0];

  // check ban status
  if (row.banned && row.ban_type === "temp" && row.ban_until && new Date(row.ban_until) < new Date()) {
    await pool.query("UPDATE users SET banned=false, ban_type=null, ban_until=null, ban_reason=null WHERE wallet=$1", [wallet]);
    row.banned = false;
  }

  res.json({
    wallet: row.wallet,
    banned: row.banned,
    ban_until: row.ban_until,
    ban_reason: row.ban_reason,
    total_staked: row.total_staked,
    total_rewards: row.total_rewards,
    fees_paid: row.fees_paid,
  });
});

// ─── PUBLIC: record a stake ─────────────────────────────────────────────────
app.post("/api/stake", async (req, res) => {
  const { wallet, amount_sol, amount_usd, stake_account, tx_sig } = req.body;
  if (!wallet || !amount_sol) return res.status(400).json({ error: "wallet and amount_sol required" });

  const u = await pool.query("SELECT banned FROM users WHERE wallet=$1", [wallet]);
  if (u.rows[0]?.banned) return res.status(403).json({ error: "Account frozen" });

  // record stake
  await pool.query(
    "INSERT INTO stakes (wallet, amount_sol, amount_usd, stake_account) VALUES ($1,$2,$3,$4)",
    [wallet, amount_sol, amount_usd || 0, stake_account || null]
  );
  await pool.query(
    "UPDATE users SET total_staked = total_staked + $1 WHERE wallet = $2",
    [amount_sol, wallet]
  );

  // record fee if paid
  if (tx_sig) {
    const feePct = parseFloat(await getSetting("fee_pct"));
    const feeAmt = (amount_sol * feePct) / 100;
    await pool.query(
      "INSERT INTO fees (wallet, amount_sol, fee_pct, tx_sig) VALUES ($1,$2,$3,$4)",
      [wallet, feeAmt, feePct, tx_sig]
    );
    await pool.query("UPDATE users SET fees_paid = fees_paid + $1 WHERE wallet=$2", [feeAmt, wallet]);
  }

  res.json({ ok: true });
});

// ─── PUBLIC: record an unstake ──────────────────────────────────────────────
app.post("/api/unstake", async (req, res) => {
  const { wallet, stake_id } = req.body;

  // check ban
  const u = await pool.query("SELECT banned FROM users WHERE wallet=$1", [wallet]);
  if (u.rows[0]?.banned) return res.status(403).json({ error: "Account frozen — cannot unstake while banned" });

  await pool.query(
    "UPDATE stakes SET status='unstaking', unstaked_at=now() WHERE id=$1 AND wallet=$2",
    [stake_id, wallet]
  );
  const s = await pool.query("SELECT amount_sol FROM stakes WHERE id=$1", [stake_id]);
  if (s.rows[0]) {
    await pool.query("UPDATE users SET total_staked=GREATEST(total_staked-$1,0) WHERE wallet=$2", [s.rows[0].amount_sol, wallet]);
  }
  res.json({ ok: true });
});

// ─── PUBLIC: user's stakes ──────────────────────────────────────────────────
app.get("/api/stakes", async (req, res) => {
  const { wallet } = req.query;
  const r = await pool.query("SELECT * FROM stakes WHERE wallet=$1 ORDER BY id DESC", [wallet]);
  res.json(r.rows);
});

// ─── ADMIN: stats panel ─────────────────────────────────────────────────────
app.get("/admin/stats", async (req, res) => {
  if (req.query.key !== ADMIN_SECRET) return res.status(403).send("forbidden");
  const [users, stakes, fees, topUsers] = await Promise.all([
    pool.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE banned) as banned FROM users"),
    pool.query("SELECT COUNT(*) as total, SUM(amount_sol) as total_sol FROM stakes WHERE status='active'"),
    pool.query("SELECT SUM(amount_sol) as total FROM fees"),
    pool.query("SELECT wallet, username, total_staked, fees_paid FROM users ORDER BY total_staked DESC LIMIT 10"),
  ]);
  res.json({
    users: { total: parseInt(users.rows[0].total), banned: parseInt(users.rows[0].banned) },
    stakes: { active: parseInt(stakes.rows[0].total), total_sol: parseFloat(stakes.rows[0].total_sol) || 0 },
    fees_collected_sol: parseFloat(fees.rows[0].total) || 0,
    top_stakers: topUsers.rows,
  });
});

// ─── ADMIN: list users ──────────────────────────────────────────────────────
app.get("/admin/users", async (req, res) => {
  if (req.query.key !== ADMIN_SECRET) return res.status(403).send("forbidden");
  const { search } = req.query;
  let q = "SELECT * FROM users ORDER BY total_staked DESC LIMIT 50";
  let params = [];
  if (search) {
    q = "SELECT * FROM users WHERE wallet ILIKE $1 OR username ILIKE $1 ORDER BY total_staked DESC LIMIT 50";
    params = ["%" + search + "%"];
  }
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// ─── ADMIN: ban a user ──────────────────────────────────────────────────────
app.post("/admin/ban", async (req, res) => {
  if (req.query.key !== ADMIN_SECRET) return res.status(403).send("forbidden");
  const { wallet, type, hours, reason } = req.body;
  if (!wallet || !type) return res.status(400).json({ error: "wallet and type required" });
  const banUntil = type === "temp" && hours ? new Date(Date.now() + hours * 3600000) : null;
  await pool.query(
    "UPDATE users SET banned=true, ban_type=$1, ban_until=$2, ban_reason=$3 WHERE wallet=$4",
    [type, banUntil, reason || null, wallet]
  );
  res.json({ ok: true, ban_until: banUntil });
});

// ─── ADMIN: unban a user ────────────────────────────────────────────────────
app.post("/admin/unban", async (req, res) => {
  if (req.query.key !== ADMIN_SECRET) return res.status(403).send("forbidden");
  const { wallet } = req.body;
  await pool.query(
    "UPDATE users SET banned=false, ban_type=null, ban_until=null, ban_reason=null WHERE wallet=$1",
    [wallet]
  );
  res.json({ ok: true });
});

// ─── ADMIN: update settings ─────────────────────────────────────────────────
app.post("/admin/settings", async (req, res) => {
  if (req.query.key !== ADMIN_SECRET) return res.status(403).send("forbidden");
  const { fee_pct, min_stake_usd, event_active, event_fee_pct, event_ends, event_label } = req.body;
  const updates = { fee_pct, min_stake_usd, event_active, event_fee_pct, event_ends, event_label };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) await setSetting(k, String(v));
  }
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`CrypticStake backend running on :${process.env.PORT || 3000}`)
);
