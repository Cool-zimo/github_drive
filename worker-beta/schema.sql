-- gd-beta · D1 表结构
-- 只存元数据。文件本体始终在 GitHub 仓库，不搬到这里。

CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,   -- 8 位短 id，分享链接用
  owner         TEXT NOT NULL,      -- GitHub login，由 token 换得，不存凭证
  repo          TEXT NOT NULL,      -- 仓库全名，如 Cool-zimo/gd
  path          TEXT NOT NULL,      -- 仓库内路径
  files         TEXT NOT NULL,      -- JSON 数组
  password_hash TEXT,               -- SHA-256，可为 NULL（无密码）
  expire_at     INTEGER,            -- Unix 秒，可为 NULL（不过期）
  views         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner);
CREATE INDEX IF NOT EXISTS idx_shares_expire ON shares(expire_at);

CREATE TABLE IF NOT EXISTS users (
  login      TEXT PRIMARY KEY,      -- GitHub login
  config     TEXT,                  -- JSON，用户配置（跨设备同步）
  updated_at INTEGER NOT NULL
);
