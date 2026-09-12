-- sakuramu-admin 的 D1 表结构。
-- 全部 IF NOT EXISTS，重复执行安全 —— 这个文件会在每次改表后整份重跑。
--
-- 写入预算（免费档 10 万行/天）：3 个监控 × 5 分钟 = 864 次探测/天，
-- 每次写 1 行 heartbeats + 更新 1 行 monitors ≈ 1,730 行/天，占 1.7%。

-- ── 监控目标 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  interval_s    INTEGER NOT NULL DEFAULT 300,
  timeout_ms    INTEGER NOT NULL DEFAULT 8000,
  expect_status INTEGER,                      -- NULL = 接受 2xx/3xx
  expect_keyword TEXT,                        -- 响应体须含此串；NULL 则不读 body
  retries       INTEGER NOT NULL DEFAULT 2,   -- 连续失败 retries+1 次才判 down
  enabled       INTEGER NOT NULL DEFAULT 1,

  -- 热状态直接挂在这行上，省得每次 cron 都去 heartbeats 里聚合一遍
  last_check_at INTEGER,
  state         TEXT    NOT NULL DEFAULT 'pending',  -- up | pending | down
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  last_ms       INTEGER,
  last_code     INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);

-- ── 心跳 ────────────────────────────────────────────────────
-- 保留 30 天（3 监控 ≈ 26,000 行 ≈ 1.5MB）。清理写在 cron 里，
-- 不做汇总表 —— 这个量级不值得。
CREATE TABLE IF NOT EXISTS heartbeats (
  monitor_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  ms         INTEGER,
  code       INTEGER,
  err        TEXT,
  PRIMARY KEY (monitor_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_hb_ts ON heartbeats(ts);

-- ── 故障事件 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id  INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  cause       TEXT,
  notified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inc_open ON incidents(monitor_id, resolved_at);

-- ── 手记 ────────────────────────────────────────────────────
-- md 和 html 都存：md 供再次编辑，html 供直接输出。
-- html 永远由服务端 render() 生成，绝不接受客户端提交的 HTML。
CREATE TABLE IF NOT EXISTS notes (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  date       TEXT NOT NULL,                  -- YYYY-MM-DD
  md         TEXT NOT NULL,
  html       TEXT NOT NULL,
  published  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_pub ON notes(published, date DESC);
