-- sakuramu-admin 的 D1 表结构。
-- 全部 IF NOT EXISTS，重复执行安全 —— 这个文件会在每次改表后整份重跑。
--
-- 写入预算（免费档 10 万行/天，**按账号算不是按库**，超限会直接拒绝查询）。
-- 注意 D1 的口径：写入涉及被索引的列时，索引也各算一行。
--   监控  4 个 × 5 分钟 ≈ 1,800 行/天
--   访客  一次完整访问 = INSERT 3（表+id索引+ts索引）+ 预算表 1
--                       + UPDATE 1 + 预算表 1 + 30 天后 DELETE 3 = 9 行
--         闸按「摄入行」设在 2 万；最坏情况含清理约 3.5 万行/天
--   合计最坏约 3.7 万行/天，占 37%，监控永远留得下余量。
--
-- 访客上报端点是公开可写的。没有那道闸的话，它被刷爆会把账号级的写入配额吃光，
-- 监控的心跳就跟着写不进去 —— 界面一片绿，其实早就瞎了。闸在 admin/src/hits.mjs。

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

-- ── 杂项键值 ────────────────────────────────────────────────
-- 目前只存一件事：cron 上次跑完是什么时候。
-- 监控系统最糟的失败模式是「自己的调度器悄悄死了，界面还一片绿」——
-- 没有这一行，那种故障从界面上完全看不出来。
CREATE TABLE IF NOT EXISTS meta (
  k  TEXT PRIMARY KEY,
  v  TEXT,
  at INTEGER NOT NULL
);

-- ── 访客统计 ────────────────────────────────────────────────
-- 隐私：不存 IP（连哈希都不做）、不存完整 User-Agent、不存完整 referrer URL、
-- 不写 Cookie。id 只用于把「离开」事件对上「进入」那一行，
-- 由页面在内存里生成、刷新即变、不能用来识别人。
CREATE TABLE IF NOT EXISTS visits (
  id       TEXT PRIMARY KEY,
  ts       INTEGER NOT NULL,        -- 服务端时间，不信客户端时钟
  site     TEXT NOT NULL,           -- 'home' | 'about'，由 Origin 推导
  path     TEXT NOT NULL,
  ref      TEXT,                    -- 只存 referrer 的主机名
  country  TEXT,                    -- request.cf.country
  -- NULL 表示没收到离开事件（浏览器崩溃、强杀 App、断网）。
  -- 统计时必须滤掉，**绝不能当成 0 秒** —— 那会把中位停留时长直接拉垮。
  dwell_ms INTEGER,
  ends     INTEGER NOT NULL DEFAULT 0   -- 收到几次离开事件，用来封顶反复更新
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);

-- 日汇总。原始记录 30 天后清理，但累计访问量不该跟着归零。
-- day 用北京时区的**整数日序号**，不是 'YYYY-MM-DD' 字符串 ——
-- 整数能当 rowid 主键，upsert 只写一行；TEXT 主键还要多写一行索引。
-- 时区规则只存在于 admin/src/hits.mjs 的 dayNum()/dayToISO() 两个函数里。
CREATE TABLE IF NOT EXISTS visit_daily (
  day       INTEGER NOT NULL,
  site      TEXT    NOT NULL,
  views     INTEGER NOT NULL DEFAULT 0,
  ended     INTEGER NOT NULL DEFAULT 0,   -- 收到离开事件的条数，用来算覆盖率
  dwell_sum INTEGER NOT NULL DEFAULT 0,
  dwell_n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site)
);

-- 当天的写入预算计数器，同时兼任配额闸。
-- 单独一张表、day 做 rowid 主键，是为了让上报热路径上的 upsert 只写一行，
-- 且闸的子查询只读一行（不是 COUNT(*) —— 那会随表变大线性放大读取）。
--
-- 这道闸是整套设计里最要紧的一处：上报端点公开可写，而 D1 的写入配额是
-- 账号级的、监控的心跳和它共用。闸没关住，监控就会静默停摆 ——
-- 界面一片绿，其实早就瞎了。
CREATE TABLE IF NOT EXISTS visit_budget (
  day          INTEGER PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0
);
