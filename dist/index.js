// src/host/dsh-adapter.ts
import { homedir as homedir3 } from "node:os";
import path10 from "node:path";

// src/store/db.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
var DB_FILENAME = "hams.db";
var DEFAULT_BUSY_TIMEOUT_MS = 5e3;
var StoreError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "StoreError";
  }
};
function resolveDataDir(explicit, env = process.env) {
  if (explicit && explicit.trim()) return path.resolve(explicit);
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(homedir(), ".dsh");
  return path.join(path.resolve(dshHome), "hams");
}
function databasePath(dataDir) {
  return path.join(path.resolve(dataDir), DB_FILENAME);
}
function openDatabase(options) {
  const readOnly = options.readOnly === true;
  if (!readOnly) mkdirSync(path.dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path, { readOnly });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    const mode = db.prepare("PRAGMA journal_mode = WAL").get();
    if (String(mode?.journal_mode ?? "").toLowerCase() !== "wal") {
      db.close();
      throw new StoreError("WAL_UNAVAILABLE", `\u65E0\u6CD5\u628A journal_mode \u5207\u5230 WAL\uFF08\u5F53\u524D ${mode?.journal_mode}\uFF09`);
    }
    db.exec("PRAGMA synchronous = FULL");
  }
  return db;
}
function isInTransaction(db) {
  return db.isTransaction === true;
}
function beginImmediate(db) {
  if (isInTransaction(db)) {
    throw new StoreError("NESTED_TRANSACTION", "BEGIN IMMEDIATE \u4E0D\u5141\u8BB8\u5D4C\u5957");
  }
  db.exec("BEGIN IMMEDIATE");
}
function commit(db) {
  db.exec("COMMIT");
}
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
  }
}
function transaction(db, fn) {
  beginImmediate(db);
  try {
    const result = fn();
    commit(db);
    return result;
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}
function userVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}
function setUserVersion(db, version) {
  if (!Number.isInteger(version) || version < 0) {
    throw new StoreError("BAD_VERSION", `user_version \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\uFF0C\u6536\u5230 ${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}
function listObjects(db) {
  const rows = db.prepare(
    `SELECT type, name, tbl_name AS "table", COALESCE(sql, '') AS sql
         FROM sqlite_master
        WHERE type IN ('table','index','trigger','view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`
  ).all();
  return rows.map((row) => ({ ...row }));
}
function tableNames(db) {
  return listObjects(db).filter((object) => object.type === "table").map((object) => object.name);
}
function tableRowCounts(db) {
  const counts = {};
  for (const name2 of tableNames(db)) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name2.replaceAll('"', '""')}"`).get();
    counts[name2] = Number(row.c);
  }
  return counts;
}
function schemaFingerprint(db) {
  const parts = listObjects(db).map((object) => `${object.type}|${object.name}|${normalizeSql(object.sql)}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}
function closeDatabase(db) {
  if (isInTransaction(db)) rollbackQuietly(db);
  db.close();
}

// src/store/lock.ts
import {
  existsSync,
  mkdirSync as mkdirSync2,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import path2 from "node:path";
var LOCK_FILENAME = "hams.lock";
var DEFAULT_STALE_MS = 3e4;
var LockHeldError = class extends StoreError {
  holder;
  constructor(holder, lockPath2) {
    super(
      "LOCK_HELD",
      holder ? `\u6570\u636E\u76EE\u5F55\u5DF2\u88AB pid=${holder.pid}\uFF08${holder.hostname}\uFF0C\u5FC3\u8DF3 ${holder.heartbeatAt}\uFF09\u6301\u6709\uFF1A${lockPath2}` : `\u6570\u636E\u76EE\u5F55\u9501\u5B58\u5728\u4F46\u5185\u5BB9\u4E0D\u53EF\u89E3\u6790\uFF0C\u5DF2\u6309\u9648\u65E7\u9501\u5904\u7406\u5931\u8D25\uFF1A${lockPath2}`
    );
    this.holder = holder;
  }
};
function lockPath(dataDir) {
  return path2.join(path2.resolve(dataDir), LOCK_FILENAME);
}
function readLock(dataDir) {
  const file = lockPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.heartbeatAt !== "number") {
      return null;
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      heartbeatAt: parsed.heartbeatAt,
      runtimeEpoch: typeof parsed.runtimeEpoch === "number" ? parsed.runtimeEpoch : 0
    };
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function writeAtomic(target, info) {
  const tmp = `${target}.${info.token}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info)}
`, { mode: 384 });
  renameSync(tmp, target);
}
function acquireLock(dataDir, options = {}) {
  const dir = path2.resolve(dataDir);
  const file = lockPath(dir);
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? osHostname();
  mkdirSync2(dir, { recursive: true });
  const candidate = {
    token: randomUUID(),
    pid,
    hostname,
    startedAt: now,
    heartbeatAt: now,
    runtimeEpoch: options.runtimeEpoch ?? 0
  };
  const current = readLock(dir);
  if (current) {
    const sameHost = current.hostname === hostname;
    const heartbeatAge = now - current.heartbeatAt;
    const dead = sameHost && !isProcessAlive(current.pid);
    const stale = dead || heartbeatAge > staleMs;
    if (!stale) {
      if (sameHost && current.pid === pid) {
        throw new StoreError(
          "LOCK_HELD_SELF",
          `\u672C\u8FDB\u7A0B\uFF08pid=${pid}\uFF09\u5DF2\u7ECF\u6301\u6709\u8BE5\u6570\u636E\u76EE\u5F55\u7684\u9501\uFF1A${file}\uFF1B\u4E0D\u8981\u91CD\u590D\u83B7\u53D6`
        );
      }
      throw new LockHeldError(current, file);
    }
  }
  writeAtomic(file, candidate);
  const confirmed = readLock(dir);
  if (!confirmed || confirmed.token !== candidate.token) {
    throw new LockHeldError(confirmed, file);
  }
  let released = false;
  const handle = {
    path: file,
    info: confirmed,
    heartbeat(at) {
      if (released) throw new StoreError("LOCK_RELEASED", "\u9501\u5DF2\u91CA\u653E\uFF0C\u4E0D\u80FD\u518D\u7EED\u671F");
      const currentInfo = readLock(dir);
      if (!currentInfo || currentInfo.token !== candidate.token) {
        throw new StoreError("LOCK_LOST", "\u9501\u5DF2\u88AB\u5176\u5B83\u8FDB\u7A0B\u63A5\u7BA1\uFF0C\u7EED\u671F\u5931\u8D25");
      }
      const next = {
        ...currentInfo,
        heartbeatAt: at ?? Date.now(),
        runtimeEpoch: currentInfo.runtimeEpoch
      };
      writeAtomic(file, next);
      handle.info = next;
      return next;
    },
    release() {
      if (released) return false;
      const currentInfo = readLock(dir);
      if (!currentInfo || currentInfo.token !== candidate.token) {
        released = true;
        return false;
      }
      unlinkSync(file);
      released = true;
      return true;
    },
    ageMs(at) {
      return (at ?? Date.now()) - handle.info.heartbeatAt;
    }
  };
  handle.info = confirmed;
  return handle;
}

// src/store/backup.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync as mkdirSync3, readdirSync, statSync, unlinkSync as unlinkSync2, existsSync as existsSync2 } from "node:fs";
import path3 from "node:path";
var BACKUP_DIRNAME = "backups";
var BACKUP_NAME_RE = /^hams-\d{8}-\d{6}-\d{2}\.db$/;
var DEFAULT_KEEP = 3;
var BackupError = class extends StoreError {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = "BackupError";
  }
};
function backupDir(dataDir) {
  return path3.join(path3.resolve(dataDir), BACKUP_DIRNAME);
}
function stamp(now) {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time2 = iso.slice(11, 19).replaceAll(":", "");
  return `${date}-${time2}`;
}
function pickName(dir, now) {
  const base = `hams-${stamp(now)}`;
  let seq = 1;
  while (existsSync2(path3.join(dir, `${base}-${String(seq).padStart(2, "0")}.db`))) seq += 1;
  return `${base}-${String(seq).padStart(2, "0")}.db`;
}
function listBackups(dir) {
  const resolved = path3.resolve(dir);
  if (!existsSync2(resolved)) return [];
  const files = [];
  for (const name2 of readdirSync(resolved)) {
    if (!BACKUP_NAME_RE.test(name2)) continue;
    const full = path3.join(resolved, name2);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    files.push({ name: name2, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  return files;
}
function checkpoint(db, mode = "TRUNCATE") {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
  return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
}
function rowCountsEqual(a, b) {
  const mismatches = [];
  for (const table of Object.keys(a)) {
    if (b[table] !== a[table]) mismatches.push(`${table}: ${a[table]} -> ${b[table] ?? "missing"}`);
  }
  for (const table of Object.keys(b)) {
    if (!(table in a)) mismatches.push(`${table}: \u526F\u672C\u591A\u51FA\u8BE5\u8868`);
  }
  return mismatches;
}
function verifyBackup(sourceDb, backupPath) {
  const copy = new DatabaseSync2(backupPath, { readOnly: true });
  try {
    const integrityRow = copy.prepare("PRAGMA integrity_check").get();
    const integrity = String(integrityRow.integrity_check);
    const sourceRows = tableRowCounts(sourceDb);
    const copyRows = tableRowCounts(copy);
    const mismatches = rowCountsEqual(sourceRows, copyRows);
    const rowsMatch = mismatches.length === 0;
    const schemaMatch = schemaFingerprint(sourceDb) === schemaFingerprint(copy);
    if (!schemaMatch) mismatches.push("\u7ED3\u6784\u6307\u7EB9\u4E0D\u4E00\u81F4");
    return {
      path: backupPath,
      integrity,
      userVersion: userVersion(copy),
      sourceUserVersion: userVersion(sourceDb),
      tables: tableNames(copy).length,
      rowsMatch,
      schemaMatch,
      mismatches
    };
  } finally {
    closeDatabase(copy);
  }
}
function createBackup(db, options) {
  const dir = path3.resolve(options.dir);
  const keep = options.keep ?? DEFAULT_KEEP;
  const now = options.now ?? /* @__PURE__ */ new Date();
  if (isInTransaction(db)) {
    throw new BackupError("BACKUP_IN_TRANSACTION", "\u5907\u4EFD\u4E0D\u80FD\u5728\u4E8B\u52A1\u5185\u505A\uFF1A\u5148\u63D0\u4EA4\u5F53\u524D\u5199\u4E8B\u52A1");
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupError("BAD_KEEP", `keep \u5FC5\u987B\u662F \u22651 \u7684\u6574\u6570\uFF0C\u6536\u5230 ${keep}`);
  }
  mkdirSync3(dir, { recursive: true });
  const checkpointResult = checkpoint(db, "TRUNCATE");
  const name2 = pickName(dir, now);
  const target = path3.join(dir, name2);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (error) {
    if (existsSync2(target)) unlinkSync2(target);
    throw new BackupError("BACKUP_FAILED", `VACUUM INTO \u5931\u8D25\uFF1A${error.message}`, { cause: error });
  }
  let verification;
  try {
    verification = verifyBackup(db, target);
  } catch (error) {
    unlinkSync2(target);
    throw new BackupError("BACKUP_UNVERIFIED", `\u5907\u4EFD\u65E0\u6CD5\u91CD\u65B0\u6253\u5F00\u6821\u9A8C\uFF0C\u5DF2\u4E22\u5F03 ${name2}`, { cause: error });
  }
  const ok2 = verification.integrity === "ok" && verification.rowsMatch && verification.schemaMatch && verification.userVersion === verification.sourceUserVersion;
  if (!ok2) {
    unlinkSync2(target);
    throw new BackupError(
      "BACKUP_UNVERIFIED",
      `\u5907\u4EFD\u6821\u9A8C\u5931\u8D25\uFF0C\u5DF2\u4E22\u5F03 ${name2}\uFF1A${verification.mismatches.join("; ") || `integrity=${verification.integrity}`}`
    );
  }
  const stat = statSync(target);
  const pruned = pruneBackups(dir, keep);
  if (!existsSync2(target)) {
    throw new BackupError("BACKUP_UNEXPECTEDLY_PRUNED", `\u4FDD\u7559\u7B56\u7565\u8BEF\u5220\u4E86\u521A\u751F\u6210\u7684\u5907\u4EFD\uFF1A${target}`);
  }
  return {
    name: name2,
    path: target,
    bytes: stat.size,
    checkpoint: checkpointResult,
    userVersion: verification.userVersion,
    tables: verification.tables,
    rows: tableRowCounts(db),
    integrity: verification.integrity,
    schemaFingerprint: schemaFingerprint(db),
    pruned
  };
}
function pruneBackups(dir, keep) {
  const resolved = path3.resolve(dir);
  const files = listBackups(resolved);
  const pruned = [];
  files.forEach((file, index) => {
    if (index < keep) return;
    if (path3.dirname(file.path) !== resolved) return;
    if (!BACKUP_NAME_RE.test(file.name)) return;
    unlinkSync2(file.path);
    pruned.push(file.name);
  });
  return pruned;
}

// src/store/schema/003_projects.sql.ts
var PROJECTS_SCHEMA_META = { "authority": "docs/schema-2026-11-14.sql", "authoritySha256": "91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7", "tableNames": ["project_phase", "project_phase_target", "project_phase_check", "project_review", "project_review_metric", "activity_daily", "member_version_skill"] };
var PROJECTS_SCHEMA_SQL = "CREATE TABLE member_version_skill (      -- [P2] \u6280\u80FD\u7ED1\u5B9A\u5728\u4E0D\u53EF\u53D8\u7684\u914D\u7F6E\u7248\u672C\u4E0A\n  member_version_id TEXT NOT NULL REFERENCES member_version(id),\n  skill_id          TEXT NOT NULL REFERENCES kb_skill(id),\n  skill_version_id  TEXT NOT NULL REFERENCES kb_skill_version(id),\n  PRIMARY KEY (member_version_id, skill_id)\n);\n\nCREATE TABLE project_phase (             -- [P2]\n  id                TEXT PRIMARY KEY,\n  project_id        TEXT NOT NULL REFERENCES project(id),\n  seq               INTEGER NOT NULL,\n  name              TEXT NOT NULL,\n  starts_at         INTEGER NOT NULL,\n  ends_at           INTEGER NOT NULL,\n  status            TEXT NOT NULL DEFAULT 'planned'\n                    CHECK (status IN ('planned','active','awaiting_confirm','done')),\n  confirmer_id      TEXT REFERENCES member(id),\n  confirmed_by      TEXT REFERENCES member(id),\n  confirmed_at      INTEGER,\n  UNIQUE (project_id, seq),\n  CHECK ((status = 'done') = (confirmed_by IS NOT NULL))\n);\n\nCREATE TABLE project_phase_target (      -- [P2]\n  id                TEXT PRIMARY KEY,\n  phase_id          TEXT NOT NULL REFERENCES project_phase(id),\n  metric_id         TEXT REFERENCES project_metric(id),\n  description       TEXT NOT NULL,\n  target_value      REAL,\n  verifier_human_id TEXT NOT NULL REFERENCES member(id)\n);\n\nCREATE TABLE project_phase_check (       -- [P2] \u52FE\u9009\u53EA\u662F\u8BB0\u5F55\n  id                TEXT PRIMARY KEY,\n  phase_id          TEXT NOT NULL REFERENCES project_phase(id),\n  label             TEXT NOT NULL,\n  checked           INTEGER NOT NULL DEFAULT 0,\n  checked_by        TEXT REFERENCES member(id),\n  checked_at        INTEGER\n);\n\nCREATE TABLE project_review (            -- [P2]\n  id                TEXT PRIMARY KEY,\n  project_id        TEXT NOT NULL REFERENCES project(id),\n  kind              TEXT NOT NULL CHECK (kind IN ('weekly','monthly','quarterly','phase')),\n  period_start      INTEGER NOT NULL,\n  period_end        INTEGER NOT NULL,\n  target_version_id TEXT NOT NULL REFERENCES project_target_version(id),\n  status            TEXT NOT NULL DEFAULT 'draft'\n                    CHECK (status IN ('draft','awaiting_confirm','confirmed')),\n  conclusion_text   TEXT,\n  confirmer_id      TEXT REFERENCES member(id),\n  confirmed_by      TEXT REFERENCES member(id),\n  confirmed_at      INTEGER,\n  UNIQUE (project_id, kind, period_start),\n  CHECK ((status = 'confirmed') = (confirmed_by IS NOT NULL))\n);\n\nCREATE TABLE project_review_metric (     -- [P2] \u590D\u76D8\u51BB\u7ED3\u5FEB\u7167\uFF1B\u7F3A\u6570\u53EA\u80FD\u662F unknown\n  review_id         TEXT NOT NULL REFERENCES project_review(id),\n  metric_id         TEXT NOT NULL REFERENCES project_metric(id),\n  target_value      REAL,\n  actual_value      REAL,\n  verdict           TEXT NOT NULL CHECK (verdict IN ('met','missed','unknown')),\n  evidence_ref      TEXT,\n  PRIMARY KEY (review_id, metric_id),\n  CHECK (actual_value IS NOT NULL OR verdict = 'unknown')\n);\n\nCREATE TABLE activity_daily (            -- [P2] \u70ED\u529B\u56FE\u65E5\u805A\u5408\uFF0C\u53EA\u7531 rollup \u4F5C\u4E1A\u5E42\u7B49\u91CD\u7B97\n  member_id         TEXT NOT NULL REFERENCES member(id),\n  date              TEXT NOT NULL,\n  runs              INTEGER NOT NULL DEFAULT 0,\n  succeeded         INTEGER NOT NULL DEFAULT 0,\n  failed            INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (member_id, date)\n);\n\nCREATE TRIGGER trg_review_metric_unknown BEFORE INSERT ON project_review_metric\nWHEN NEW.verdict <> 'unknown' AND EXISTS (\n  SELECT 1 FROM project_metric m WHERE m.id = NEW.metric_id\n     AND (m.calculator_key IS NULL OR m.source_kind IS NULL))\nBEGIN SELECT RAISE(ABORT, 'DATA_STALE: metric without calculator or source can only be unknown'); END;\n";

// src/store/schema/004_team.sql.ts
var TEAM_SCHEMA_META = {
  tableNames: ["project_participant", "project_message", "chat_cursor"],
  note: "v4 \u9879\u76EE\u7FA4\u56E2\u961F\uFF1Aparticipants / merged messages / session cursor"
};
var TEAM_SCHEMA_SQL = `-- [P4] \u4E34\u65F6 bot \u7684\u5F52\u5C5E\u9879\u76EE\uFF1BNULL = \u5E38\u89C4\u6210\u5458
ALTER TABLE member ADD COLUMN scope_project_id TEXT;

CREATE TABLE project_participant (       -- [P4] \u9879\u76EE\u7FA4\u6210\u5458\uFF08\u4E0D\u5305\u542B\u63A8\u8FDB bot\uFF0C\u5B83\u5728 project.coordinator_id\uFF09
  project_id        TEXT NOT NULL REFERENCES project(id),
  member_id         TEXT NOT NULL REFERENCES member(id),
  kind              TEXT NOT NULL CHECK (kind IN ('member','temp')),
  brief             TEXT NOT NULL DEFAULT '',
  added_by          TEXT NOT NULL REFERENCES member(id),
  added_at          INTEGER NOT NULL,
  removed_by        TEXT REFERENCES member(id),
  removed_at        INTEGER,
  PRIMARY KEY (project_id, member_id)
);

CREATE INDEX idx_project_participant_active ON project_participant(project_id) WHERE removed_at IS NULL;

CREATE TABLE project_message (           -- [P4] \u7FA4\u804A\u5408\u5E76\u8BB0\u5F55
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  author_kind   TEXT NOT NULL CHECK (author_kind IN ('human','bot','system')),
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  text          TEXT NOT NULL,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','mention','system')),
  to_member_id  TEXT,
  session_id    TEXT
);

CREATE INDEX idx_project_message_project ON project_message(project_id, at, id);

CREATE TABLE chat_cursor (               -- [P4] \u4F1A\u8BDD\u4E8B\u4EF6\u5DF2\u5408\u5E76\u5230\u54EA\u4E00\u6761
  session_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id),
  last_seq    INTEGER NOT NULL DEFAULT 0
);
`;

// src/store/schema/005_target_check.sql.ts
var TARGET_CHECK_SCHEMA_META = {
  tableNames: ["project_phase_target_check"],
  note: "v5 \u9636\u6BB5\u76EE\u6807\u68C0\u9A8C\u8BB0\u5F55\uFF08submitted_by / result / report_url\uFF09"
};
var TARGET_CHECK_SCHEMA_SQL = `CREATE TABLE project_phase_target_check (   -- [P5] \u9636\u6BB5\u76EE\u6807\u7684\u68C0\u9A8C\u63D0\u4EA4
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  target_id     TEXT NOT NULL REFERENCES project_phase_target(id),
  submitted_by  TEXT NOT NULL REFERENCES member(id),
  submitted_at  INTEGER NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('met','missed','unknown')),
  report_url    TEXT,
  note          TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_phase_target_check_target ON project_phase_target_check(target_id, submitted_at);
`;

// src/store/schema/006_target_flow.sql.ts
var TARGET_FLOW_SCHEMA_META = {
  tableNames: [],
  note: "v6 \u9636\u6BB5\u76EE\u6807\u8BF4\u660E + \u68C0\u9A8C\u63D0\u4EA4\u7684\u5BA1\u6279\u5B57\u6BB5\uFF08ALTER TABLE\uFF09"
};
var TARGET_FLOW_SCHEMA_SQL = `ALTER TABLE project_phase_target ADD COLUMN detail TEXT NOT NULL DEFAULT '';

ALTER TABLE project_phase_target_check ADD COLUMN approver_id TEXT REFERENCES member(id);
ALTER TABLE project_phase_target_check ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE project_phase_target_check ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE project_phase_target_check ADD COLUMN decided_by TEXT REFERENCES member(id);
ALTER TABLE project_phase_target_check ADD COLUMN decided_at INTEGER;
ALTER TABLE project_phase_target_check ADD COLUMN decision_note TEXT NOT NULL DEFAULT '';
`;

// src/store/schema/007_project_delete.sql.ts
var PROJECT_DELETE_SCHEMA_SQL = `ALTER TABLE project ADD COLUMN deleted_at INTEGER;
ALTER TABLE project ADD COLUMN deleted_by TEXT REFERENCES member(id);
-- \u9879\u76EE\u540D\u6709 UNIQUE \u7EA6\u675F\uFF1A\u8F6F\u5220\u65F6\u628A\u540D\u5B57\u6539\u6210\u5893\u7891\uFF0C\u539F\u503C\u7559\u5728\u8FD9\u91CC\uFF0C\u540D\u5B57\u53EF\u590D\u7528\u3002
ALTER TABLE project ADD COLUMN deleted_name TEXT;
`;

// src/store/schema/008_memory.sql.ts
var MEMORY_SCHEMA_SQL = `CREATE TABLE project_memory (           -- [P4] \u9879\u76EE\u63A8\u8FDB\u8FC7\u7A0B\u4E2D\u6536\u96C6\u7684\u8BB0\u5FC6
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  kind          TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','lesson','capability')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('auto','manual','tool')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  member_id     TEXT REFERENCES member(id),       -- \u80FD\u529B\u7C7B\u8BB0\u5FC6\u5F52\u5C5E\u7684 bot\uFF1B\u5176\u5B83\u7C7B\u578B\u4E3A NULL
  source_ref    TEXT,                             -- message:<id> / manual / tool
  dedupe_key    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES member(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, dedupe_key)
);

CREATE INDEX idx_project_memory_project ON project_memory(project_id, status, created_at);

CREATE TABLE bot_memory (             -- [P4] \u80FD\u529B\u7C7B\u8BB0\u5FC6\u540C\u6B65\u7ED9 bot \u7684\u5FEB\u7167
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES member(id),
  project_id    TEXT NOT NULL REFERENCES project(id),
  memory_id     TEXT NOT NULL REFERENCES project_memory(id),
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (member_id, memory_id)
);

CREATE INDEX idx_bot_memory_member ON bot_memory(member_id, created_at);
`;

// src/store/schema/009_bot_prompt.sql.ts
var BOT_PROMPT_SCHEMA_SQL = `ALTER TABLE member_version ADD COLUMN prompt TEXT NOT NULL DEFAULT '';

-- \u6CE8\u610F\uFF1Amember_version \u6709 IMMUTABLE \u89E6\u53D1\u5668\uFF08\u53D1\u5E03\u5373\u4E0D\u53EF\u53D8\uFF09\uFF0C\u8FC1\u79FB\u91CC\u4E0D\u80FD\u56DE\u586B\u5DF2\u6709\u884C\u3002
-- \u5DF2\u6709 bot \u7684 prompt \u4FDD\u6301\u7A7A\u5B57\u7B26\u4E32\uFF08\u53EA\u6709 HAMS \u57FA\u7840\u89C4\u5219\uFF09\uFF0C\u9700\u8981\u65F6\u7531\u4EBA\u53D1\u5E03\u65B0\u7248\u672C\u8865\u4E0A\uFF1B
-- \u65B0\u5EFA bot \u5728 insertMember \u91CC\u9ED8\u8BA4\u7528\u804C\u8D23\u4F5C\u4E3A\u521D\u7248\u63D0\u793A\u8BCD\u3002
`;

// src/store/schema/001_p1.sql.ts
var P1_SCHEMA_SQL = `-- \u26A0\uFE0F \u81EA\u52A8\u751F\u6210\uFF0C\u8BF7\u52FF\u624B\u6539\u3002
-- \u6765\u6E90\uFF08\u6743\u5A01\uFF09\uFF1Adocs/schema-2026-11-14.sql
-- \u6743\u5A01\u6587\u4EF6 sha256\uFF1A91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7
-- \u751F\u6210\u547D\u4EE4\uFF1Anode scripts/split-schema.mjs
-- \u5185\u5BB9\uFF1AP1 41 \u8868 / 30 \u7D22\u5F15 / 31 \u89E6\u53D1\u5668 / 2 \u79CD\u5B50\u8BED\u53E5
-- \u5206\u671F\u4F9D\u636E\uFF1A\u8868\u6CE8\u91CA\u91CC\u7684 [P1] / [P2] / [\u58F3] \u6807\u8BB0\uFF1B\u89E6\u53D1\u5668\u6309\u5B83\u5F15\u7528\u7684\u8868\u53D6\u6700\u665A\u4E00\u6863\u3002
CREATE TABLE hams_meta (                 -- [P1] schema_version / runtime_epoch / primary_workspace_id / last_tick_at
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 1. \u6210\u5458\u3001\u5C97\u4F4D\u4E0E\u6388\u6743 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE member (                    -- [P1] \u4EBA\u3001bot \u4E0E\u552F\u4E00\u7684\u7CFB\u7EDF\u4E3B\u4F53\u5171\u7528\u4E3B\u952E\u7A7A\u95F4
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('human','bot','system')),
  name              TEXT NOT NULL,
  domain            TEXT,
  responsibility    TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'executor'
                    CHECK (role IN ('coordinator','executor','observer')),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','retired')),
  current_version   INTEGER NOT NULL DEFAULT 0,
  owner_human_id    TEXT REFERENCES member(id),      -- bot \u7684\u8D23\u4EFB\u4EBA
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (kind <> 'bot' OR owner_human_id IS NOT NULL)
);

CREATE INDEX idx_member_kind ON member(kind, status);

CREATE UNIQUE INDEX uq_member_system ON member(kind) WHERE kind = 'system';

INSERT INTO member (id, kind, name, created_at, updated_at) VALUES ('system', 'system', '\u7CFB\u7EDF', 0, 0);

CREATE TABLE member_version (            -- [P1] bot \u914D\u7F6E\u5FEB\u7167\uFF1A\u53D1\u5E03\u5373\u4E0D\u53EF\u53D8
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES member(id),
  version           INTEGER NOT NULL,
  agent_preset      TEXT,                            -- \u5BBF\u4E3B agentPreset\uFF08\u4E0D\u662F permissionPresets\uFF09
  model             TEXT,
  memory_scope_json TEXT NOT NULL DEFAULT '{}',
  prompt_digest     TEXT NOT NULL,
  change_class      TEXT NOT NULL DEFAULT 'minor' CHECK (change_class IN ('minor','major')),
  published_by      TEXT NOT NULL REFERENCES member(id),
  published_at      INTEGER NOT NULL,
  UNIQUE (member_id, version)
);

CREATE TABLE member_permission (         -- [P1] \u53EA\u7528\u4E8E bot\uFF1B\u4EBA\u7684\u6743\u9650\u8D70\u5C97\u4F4D
  member_id         TEXT NOT NULL REFERENCES member(id),
  capability        TEXT NOT NULL,
  scope             TEXT NOT NULL,                   -- domain:<\u57DF> | project:<id> | global
  granted_by        TEXT NOT NULL REFERENCES member(id),
  granted_at        INTEGER NOT NULL,
  PRIMARY KEY (member_id, capability, scope)
);

CREATE TABLE member_tool_policy (        -- [P1] \u65E0\u8BB0\u5F55 = \u4E0D\u53EF\u7528
  member_id         TEXT NOT NULL REFERENCES member(id),
  tool_name         TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, tool_name)
);

CREATE TABLE hams_user (                 -- [P1] \u767B\u5F55\u8EAB\u4EFD \u2192 human \u6210\u5458\uFF1BHAMS \u4E0D\u5B58\u53E3\u4EE4\u3001\u4E0D\u53D1 token
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL UNIQUE REFERENCES member(id),
  login             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  auth_source       TEXT NOT NULL CHECK (auth_source IN ('local_host','sso','gateway_local')),
  external_id       TEXT NOT NULL,                   -- \u5BBF\u4E3B\u8D26\u53F7 id / OIDC sub / \u7F51\u5173\u672C\u5730\u8D26\u53F7\u540D
  expires_at        INTEGER,                         -- gateway_local \u515C\u5E95\u8D26\u53F7\u5FC5\u987B\u9650\u671F
  is_admin          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at     INTEGER,
  UNIQUE (auth_source, external_id),
  CHECK (auth_source <> 'gateway_local' OR expires_at IS NOT NULL)
);

CREATE TABLE position (                  -- [P1] \u6743\u9650\u6302\u5C97\u4F4D
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  domain            TEXT,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired'))
);

CREATE TABLE position_permission (     -- [P1]
  position_id       TEXT NOT NULL REFERENCES position(id),
  capability        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  PRIMARY KEY (position_id, capability, scope)
);

CREATE TABLE member_position (           -- [P1] \u5728\u5C97\u533A\u95F4 [starts_at, ends_at)
  member_id         TEXT NOT NULL REFERENCES member(id),
  position_id       TEXT NOT NULL REFERENCES position(id),
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER,
  assigned_by       TEXT NOT NULL REFERENCES member(id),
  PRIMARY KEY (member_id, position_id, starts_at),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX idx_mp_active ON member_position(member_id, ends_at);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 3. \u9879\u76EE\u4E0E\u6307\u6807 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE project (                   -- [P1]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL CHECK (type IN ('one_off','continuous')),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','archived')),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),
  coordinator_id    TEXT REFERENCES member(id),
  goal_text         TEXT NOT NULL,
  current_target_version INTEGER NOT NULL DEFAULT 0,
  no_progress_streak INTEGER NOT NULL DEFAULT 0,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE project_target_version (    -- [P1] \u53E3\u5F84\u7248\u672C\uFF1A\u53D1\u5E03\u5373\u51BB\u7ED3
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  version           INTEGER NOT NULL,
  goal_text         TEXT NOT NULL,
  published_by      TEXT NOT NULL REFERENCES member(id),
  published_at      INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE project_metric (            -- [P1] \u53E3\u5F84 = \u9884\u7F6E\u8BA1\u7B97\u5668 + \u53C2\u6570\uFF0C\u4E0D\u5B58\u81EA\u7531\u8868\u8FBE\u5F0F
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  version_id        TEXT NOT NULL REFERENCES project_target_version(id),
  name              TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('higher','lower','range')),
  target_value      REAL,
  target_max        REAL,                            -- direction='range' \u65F6\u7684\u4E0A\u754C
  unit              TEXT,
  definition_text   TEXT NOT NULL DEFAULT '',        -- \u7ED9\u4EBA\u770B\u7684\u53E3\u5F84\u8BF4\u660E
  calculator_key    TEXT,                            -- \u4F8B\uFF1Aratio_of_counts\uFF1BNULL = \u672A\u5B9A\u4E49\u53E3\u5F84
  calculator_params_json TEXT NOT NULL DEFAULT '{}',
  window_kind       TEXT NOT NULL CHECK (window_kind IN ('day','week','month','snapshot')),
  source_kind       TEXT CHECK (source_kind IS NULL OR source_kind IN ('ledger','work_item','webhook','manual')),
  source_ref        TEXT,
  trial_value       REAL,                            -- \u53D1\u5E03\u524D\u8BD5\u7B97\u7ED3\u679C
  trial_at          INTEGER,
  UNIQUE (version_id, name)
);

CREATE TABLE project_budget (            -- [P1] \u989D\u5EA6\u6309\u300C\u5468\u671F\u7C7B\u578B + \u5468\u671F\u8D77\u70B9 + \u8BA1\u91CF\u9879\u300D\u8BB0\u8D26
  project_id        TEXT NOT NULL REFERENCES project(id),
  period_kind       TEXT NOT NULL CHECK (period_kind IN ('day','week')),
  period_start      TEXT NOT NULL,                   -- YYYY-MM-DD\uFF08\u9879\u76EE\u65F6\u533A\uFF09
  metric            TEXT NOT NULL CHECK (metric IN ('new_tasks','proposals')),
  used              INTEGER NOT NULL DEFAULT 0,
  limit_value       INTEGER NOT NULL,
  PRIMARY KEY (project_id, period_kind, period_start, metric)
);

CREATE TABLE metric_observation (        -- [P1] value NULL = \u7F3A\u6570
  id                TEXT PRIMARY KEY,
  metric_id         TEXT NOT NULL REFERENCES project_metric(id),
  observed_at       INTEGER NOT NULL,
  window_start      INTEGER NOT NULL,
  window_end        INTEGER NOT NULL,
  value             REAL,
  source_ref        TEXT,
  ingested_at       INTEGER NOT NULL
);

CREATE INDEX idx_obs_metric ON metric_observation(metric_id, window_end DESC);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 4. \u8D44\u4EA7\u3001\u6A21\u677F\u4E0E\u5165\u7AD9\u4E8B\u4EF6 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE asset (                     -- [P1] \u5916\u90E8\u8D44\u4EA7\u7684\u7A33\u5B9A\u6620\u5C04
  id                TEXT PRIMARY KEY,
  external_system   TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'battery',
  display_name      TEXT NOT NULL,
  last_snapshot_date TEXT,
  UNIQUE (external_system, external_id)
);

CREATE TABLE ledger_snapshot (           -- [P1] Hive \u53F0\u8D26\u955C\u50CF\uFF0C\u9875\u9762\u53EA\u67E5\u672C\u5730
  snapshot_date     TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES asset(id),
  status            TEXT,
  attrs_json        TEXT NOT NULL DEFAULT '{}',
  source_ref        TEXT NOT NULL,
  ingested_at       INTEGER NOT NULL,
  PRIMARY KEY (snapshot_date, asset_id)
);

CREATE INDEX idx_ledger_asset ON ledger_snapshot(asset_id, snapshot_date DESC);

CREATE TABLE work_template (             -- [P1]
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,            -- \u4F8B\uFF1Abattery_alert_tracking
  name              TEXT NOT NULL,
  domain            TEXT NOT NULL,
  category          TEXT NOT NULL,
  published_version_id TEXT REFERENCES work_template_version(id)
);

CREATE TABLE work_template_version (     -- [P1] \u5173\u95ED\u5224\u636E\u7684\u51FA\u5904\uFF1A\u8BC1\u636E\u8981\u6C42\u3001\u590D\u67E5\u7B56\u7565\u3001\u9A8C\u6536\u7B56\u7565
  id                TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL REFERENCES work_template(id),
  version           INTEGER NOT NULL,
  required_evidence_json TEXT NOT NULL DEFAULT '[]', -- [{kind,min_count,max_age_hours}]
  validator_key     TEXT,                            -- \u4EE3\u7801\u5185\u7F6E\u7684\u5177\u540D\u9A8C\u8BC1\u5668\uFF1BNULL = \u53EA\u505A\u8BC1\u636E\u6E05\u5355\u6838\u5BF9
  validator_params_json TEXT NOT NULL DEFAULT '{}',
  check_policy_json TEXT NOT NULL DEFAULT '{}',      -- {mode:'next_day_at',time:'09:00',tz,max_rechecks}
  review_policy_json TEXT NOT NULL DEFAULT '{}',     -- {approver:'owner'|'position:<id>',expires_hours,auto_close}
  misfire_policy    TEXT NOT NULL DEFAULT 'each' CHECK (misfire_policy IN ('each','catch_up_latest','skip')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_by      TEXT REFERENCES member(id),
  published_at      INTEGER,
  UNIQUE (template_id, version)
);

CREATE TABLE event_inbox (               -- [P1] \u5165\u7AD9\u4E8B\u4EF6\u5E42\u7B49\uFF1A\u540C\u4E00\u5916\u90E8\u4E8B\u4EF6\u53EA\u4EA7\u751F\u4E00\u6B21\u4E1A\u52A1\u6548\u679C
  id                TEXT PRIMARY KEY,
  connector         TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  asset_id          TEXT REFERENCES asset(id),
  event_type        TEXT NOT NULL,
  severity          INTEGER NOT NULL DEFAULT 0,
  payload_ref       TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  occurred_at       INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  work_item_id      TEXT REFERENCES work_item(id),   -- \u5904\u7F6E\u540E\u56DE\u586B
  disposition       TEXT NOT NULL DEFAULT 'received'
                    CHECK (disposition IN ('received','created','attached','escalated','ignored')),
  UNIQUE (connector, external_event_id)
);

CREATE INDEX idx_inbox_asset ON event_inbox(asset_id, occurred_at DESC);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 5. \u5DE5\u4F5C\u9879\u3001\u8FD0\u884C\u4E0E\u8BC1\u636E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE work_item_transition (      -- [P1] \u72B6\u6001\u767D\u540D\u5355\uFF1A\u57DF\u4EE3\u7801\u4E0E\u89E6\u53D1\u5668\u5171\u7528\u8FD9\u4E00\u4EFD
  from_status       TEXT NOT NULL,
  to_status         TEXT NOT NULL,
  command           TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO work_item_transition (from_status, to_status, command) VALUES
  ('ready','active','claim|accept'),
  ('ready','blocked','reportBlocker'),
  ('ready','paused','pause'),
  ('ready','cancelled','cancel'),
  ('active','ready','release|takeOver|handoff/accept'),
  ('active','waiting_check','submitResult'),
  ('active','waiting_review','requestClosure'),
  ('active','blocked','reportBlocker'),
  ('active','paused','pause'),
  ('active','failed','fail'),
  ('active','cancelled','cancel'),
  ('waiting_check','active','check failed'),
  ('waiting_check','waiting_review','requestClosure'),
  ('waiting_check','blocked','check unknown|retries exhausted|reportBlocker'),
  ('waiting_check','paused','pause'),
  ('waiting_check','cancelled','cancel'),
  ('waiting_review','completed','approval approve|auto close'),
  ('waiting_review','active','approval reject|approval authorize'),
  ('waiting_review','blocked','approval return'),
  ('waiting_review','paused','pause'),
  ('waiting_review','cancelled','cancel'),
  ('blocked','ready','unblock'),
  ('blocked','active','unblock'),
  ('blocked','waiting_check','scheduleCheck'),
  ('blocked','waiting_review','requestClosure'),
  ('blocked','paused','pause'),
  ('blocked','cancelled','cancel'),
  ('paused','ready','resume'),
  ('paused','active','resume'),
  ('paused','waiting_check','resume'),
  ('paused','waiting_review','resume'),
  ('paused','blocked','resume'),
  ('paused','cancelled','cancel'),
  ('completed','ready','reopen'),
  ('failed','ready','retry'),
  ('failed','cancelled','cancel');

CREATE TABLE work_item (                 -- [P1]
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id),
  parent_id         TEXT REFERENCES work_item(id),
  template_version_id TEXT REFERENCES work_template_version(id),
  asset_id          TEXT REFERENCES asset(id),
  domain            TEXT NOT NULL,
  category          TEXT NOT NULL,
  title             TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('ready','active','waiting_check','waiting_review','blocked',
                                      'paused','completed','failed','cancelled')),
  resume_state      TEXT CHECK (resume_state IS NULL OR resume_state IN
                                ('ready','active','waiting_check','waiting_review','blocked')),
  blocked_reason    TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN
                                ('needs_evidence','external','dependency','permission','human_input','data_source')),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),   -- \u5BF9\u7ED3\u679C\u8D1F\u8D23\u7684\u4EBA
  assignee_id       TEXT REFERENCES member(id),            -- \u5F53\u524D\u6267\u884C\u8005\uFF1A\u4EBA\u6216 bot
  due_at            INTEGER,
  next_action_at    INTEGER,
  check_generation  INTEGER NOT NULL DEFAULT 0,
  close_requires_approval INTEGER NOT NULL DEFAULT 1,
  dedupe_key        TEXT,                                  -- \u4F8B\uFF1Aalert:BT-20871:overdischarge
  revision          INTEGER NOT NULL DEFAULT 1,            -- \u5BF9\u8C61\u4FEE\u8BA2\u53F7\uFF1A\u884C\u6216\u8BC1\u636E\u96C6\u6BCF\u53D8\u4E00\u6B21 +1
  execution_epoch   INTEGER NOT NULL DEFAULT 1,            -- \u6267\u884C\u4EE3\u6B21\uFF1A\u6682\u505C/\u6062\u590D/\u53D6\u6D88/\u91CD\u5F00/\u6362\u6267\u884C\u8005 +1
  fence_seq         INTEGER NOT NULL DEFAULT 0,            -- \u79DF\u7EA6\u6805\u680F\u53F7\u53D1\u53F7\u5668
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- \u6709\u6548\u8BC1\u636E\u96C6\u7684\u54C8\u5E0C
  created_by        TEXT NOT NULL REFERENCES member(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  CHECK ((status = 'paused') = (resume_state IS NOT NULL)),
  CHECK (status = 'blocked' OR resume_state IS 'blocked' OR blocked_reason IS NULL)
);

-- \u53BB\u91CD\u53EA\u7EA6\u675F\u300C\u4ECD\u5728\u5904\u7406\u300D\u7684\u5355\uFF1A\u5173\u5355\u540E\u540C\u4E00\u7535\u6C60\u518D\u6B21\u544A\u8B66\u53EF\u4EE5\u65B0\u5EFA
CREATE UNIQUE INDEX uq_wi_dedupe ON work_item(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed','cancelled');

CREATE INDEX idx_wi_status_due ON work_item(status, next_action_at);

CREATE INDEX idx_wi_assignee ON work_item(assignee_id, status);

CREATE INDEX idx_wi_owner ON work_item(owner_human_id, status);

CREATE INDEX idx_wi_asset ON work_item(asset_id, created_at DESC);

CREATE INDEX idx_wi_project ON work_item(project_id, domain, status);

CREATE TABLE work_item_relation (        -- [P1]
  from_id           TEXT NOT NULL REFERENCES work_item(id),
  to_id             TEXT NOT NULL REFERENCES work_item(id),
  kind              TEXT NOT NULL CHECK (kind IN ('blocks','duplicate_of','caused_by')),
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

CREATE TABLE work_item_event (           -- [P1] \u8FFD\u52A0\u5F0F\u65F6\u95F4\u7EBF
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  kind              TEXT NOT NULL,
  actor_id          TEXT NOT NULL REFERENCES member(id),   -- \u7CFB\u7EDF\u52A8\u4F5C\u7528 'system'
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','bot','system')),
  payload_json      TEXT NOT NULL DEFAULT '{}',
  revision          INTEGER NOT NULL,
  execution_epoch   INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_event_wi ON work_item_event(work_item_id, created_at);

CREATE TABLE work_item_thread (          -- [P1] \u5DE5\u4F5C\u9879\u7684\u4F1A\u8BDD\u4EE3\u6B21\uFF1A\u5386\u53F2\u5168\u4FDD\u7559\uFF0C\u540C\u65F6\u53EA\u6709\u4E00\u6761\u5728\u7528
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  generation        INTEGER NOT NULL,
  session_id        TEXT NOT NULL UNIQUE,                  -- \u5BBF\u4E3B\u4F1A\u8BDD id\uFF1B\u4E0D\u5F97\u8DE8\u5DE5\u4F5C\u9879\u590D\u7528
  member_id         TEXT NOT NULL REFERENCES member(id),
  member_version    INTEGER NOT NULL,                      -- \u5F00\u4F1A\u8BDD\u65F6\u56FA\u5316\u7684\u914D\u7F6E\u7248\u672C
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','pending_rotate','rotated','closed')),
  turn_count        INTEGER NOT NULL DEFAULT 0,
  rotate_after_turns INTEGER NOT NULL DEFAULT 200,
  rotate_after_days INTEGER NOT NULL DEFAULT 30,
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  close_reason      TEXT,
  UNIQUE (work_item_id, generation)
);

CREATE UNIQUE INDEX uq_thread_current ON work_item_thread(work_item_id)
  WHERE status IN ('active','pending_rotate');

CREATE TABLE work_item_check (           -- [P1] \u590D\u67E5\uFF1A\u6BCF\u4E2A\u4EE3\u6B21\u4E00\u6761\uFF0C\u6309\u6A21\u677F\u7248\u672C\u5224\u5B9A
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  generation        INTEGER NOT NULL,
  execution_epoch   INTEGER NOT NULL,
  template_version_id TEXT REFERENCES work_template_version(id),
  planned_due_at    INTEGER NOT NULL,                      -- \u53CA\u65F6\u7387\u6309\u5B83\u7B97\uFF0C\u4E0D\u6309\u5B9E\u9645\u6267\u884C\u65F6\u95F4
  status            TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','running','passed','failed','unknown','cancelled')),
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- \u5224\u5B9A\u65F6\u7684\u8BC1\u636E\u96C6
  result_json       TEXT NOT NULL DEFAULT '{}',
  evaluated_at      INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (work_item_id, generation)
);

CREATE INDEX idx_check_due ON work_item_check(status, planned_due_at);

CREATE TABLE task_run (                  -- [P1] bot \u7684\u4E00\u6B21\u6267\u884C\u5C1D\u8BD5
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  thread_id         TEXT NOT NULL REFERENCES work_item_thread(id),
  check_id          TEXT REFERENCES work_item_check(id),
  member_id         TEXT NOT NULL REFERENCES member(id),
  member_version    INTEGER NOT NULL,
  skill_versions_json TEXT NOT NULL DEFAULT '{}',
  execution_epoch   INTEGER NOT NULL,                      -- \u521B\u5EFA\u65F6\u5DE5\u4F5C\u9879\u7684\u6267\u884C\u4EE3\u6B21
  runtime_epoch     INTEGER NOT NULL,                      -- \u521B\u5EFA\u65F6\u7684\u5BBF\u4E3B\u542F\u52A8\u4EE3\u6B21
  fence             INTEGER NOT NULL,
  trigger           TEXT NOT NULL CHECK (trigger IN ('claim','check','schedule','manual','retry','instruction')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','cancelled','orphaned','unknown')),
  result_summary    TEXT,
  error_kind        TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  UNIQUE (work_item_id, fence)
);

CREATE UNIQUE INDEX uq_wi_active_run ON task_run(work_item_id) WHERE status IN ('queued','running');

CREATE UNIQUE INDEX uq_member_active_run ON task_run(member_id) WHERE status = 'running';

CREATE INDEX idx_run_runtime ON task_run(runtime_epoch, status);

CREATE TABLE run_step (                  -- [P1] \u7C97\u7C92\u5EA6\u6B65\u9AA4\u6458\u8981\uFF1B\u4E0D\u5B58 token \u7EA7\u660E\u7EC6
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES task_run(id),
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('reason','tool','message','wait_human','error')),
  tool_name         TEXT,
  summary           TEXT NOT NULL,
  payload_ref       TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE lease (                     -- [P1] \u53EA\u7BA1 bot \u7684\u6D3B\u8DC3\u8FD0\u884C\uFF1B\u4EBA\u7684\u8BA4\u9886\u4E0D\u9760\u79DF\u7EA6
  work_item_id      TEXT PRIMARY KEY REFERENCES work_item(id),
  holder_member_id  TEXT NOT NULL REFERENCES member(id),
  run_id            TEXT NOT NULL REFERENCES task_run(id),
  fence             INTEGER NOT NULL,
  runtime_epoch     INTEGER NOT NULL,
  lease_until       INTEGER NOT NULL,
  renewed_at        INTEGER NOT NULL
);

CREATE INDEX idx_lease_expiry ON lease(lease_until);

CREATE TABLE evidence (                  -- [P1] \u8FFD\u52A0\u5F0F\uFF1B\u66F4\u6B63\u53E6\u8D77\u4E00\u884C\u5E76\u6307\u5411\u88AB\u66FF\u4EE3\u7684\u90A3\u884C
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  run_id            TEXT REFERENCES task_run(id),
  kind              TEXT NOT NULL,                         -- reading / photo / receipt / log / doc
  ref               TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT '',
  observed_at       INTEGER NOT NULL,                      -- \u4E8B\u5B9E\u53D1\u751F\u65F6\u95F4
  captured_at       INTEGER NOT NULL,
  captured_by       TEXT NOT NULL REFERENCES member(id),
  on_behalf_of      TEXT REFERENCES member(id),            -- \u4EE3\u5F55\u65F6\u586B\u5B9E\u9645\u53CD\u9988\u4EBA
  supersedes_id     TEXT REFERENCES evidence(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','stale')),
  verified_by       TEXT REFERENCES member(id),
  verified_at       INTEGER,
  purged_at         INTEGER                                -- \u4FDD\u7559\u671F\u6EE1\u53EA\u5220\u6587\u4EF6\uFF0C\u884C\u4E0E\u54C8\u5E0C\u4FDD\u7559
);

CREATE INDEX idx_ev_wi ON evidence(work_item_id, kind, status);

CREATE TABLE handoff (                   -- [P1]
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  from_member_id    TEXT NOT NULL REFERENCES member(id),
  to_member_id      TEXT NOT NULL REFERENCES member(id),
  reason_kind       TEXT NOT NULL CHECK (reason_kind IN
                     ('need_physical_action','need_authority','out_of_domain','capability_missing','takeover')),
  note              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  CHECK (from_member_id <> to_member_id)
);

CREATE UNIQUE INDEX uq_handoff_pending ON handoff(work_item_id) WHERE status = 'pending';

CREATE TABLE attention_item (            -- [P1] \u9700\u4EBA\u5173\u6CE8\u4E8B\u9879\uFF1A\u5B64\u513F\u8FD0\u884C\u3001\u91CD\u8BD5\u8017\u5C3D\u3001\u8FDE\u7EED\u65E0\u8FDB\u5C55\u3001\u544A\u8B66\u52A0\u91CD\u3001\u5916\u53D1\u7ED3\u679C\u672A\u77E5\u3001\u6F0F\u8DD1\u3002\u4E0E\u5BA1\u6279\u8D85\u65F6\u65E0\u5173
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT REFERENCES work_item(id),
  project_id        TEXT REFERENCES project(id),
  reason            TEXT NOT NULL CHECK (reason IN
                     ('orphaned_run','retries_exhausted','no_progress','severity_raised','outbox_unknown','missed_check')),
  detail            TEXT NOT NULL DEFAULT '',
  to_member_id      TEXT NOT NULL REFERENCES member(id),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT REFERENCES member(id)
);

CREATE INDEX idx_attention_open ON attention_item(to_member_id, resolved_at);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 6. \u63D0\u8BAE\u4E0E\u5BA1\u6279 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE proposal (                  -- [P1] bot \u7684\u300C\u6211\u60F3\u505A\u8FD9\u4EF6\u4E8B\u300D
  id                TEXT PRIMARY KEY,
  subject_key       TEXT NOT NULL,                         -- project:<id> | work_item:<id> | global\uFF08\u4E0D\u7528 NULL\uFF09
  project_id        TEXT REFERENCES project(id),
  work_item_id      TEXT REFERENCES work_item(id),
  kind              TEXT NOT NULL CHECK (kind IN
                     ('create_task','upgrade_task','permission_request','scope_change','knowledge_change')),
  dedupe_key        TEXT NOT NULL,                         -- \u89C4\u8303\u5316\u540E\u7684\u610F\u56FE\u952E\uFF0C\u4F8B\uFF1Arecount:offline-12
  proposed_by       TEXT NOT NULL REFERENCES member(id),
  decider_id        TEXT NOT NULL REFERENCES member(id),   -- \u7531\u8C01\u51B3\u5B9A\uFF08\u9ED8\u8BA4\u9879\u76EE\u8D1F\u8D23\u4EBA\uFF09
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  rationale_json    TEXT NOT NULL,                         -- {evidence:[...],expected_effect,cost}\uFF1Bevidence \u4E3A\u7A7A\u4E0D\u843D\u5E93
  impact_json       TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','accepted','rejected','expired','superseded')),
  duplicate_count   INTEGER NOT NULL DEFAULT 0,
  snoozed_until     INTEGER,                               -- \u300C\u7A0D\u540E\u518D\u8BF4\u300D\u53EA\u6539\u8FD9\u91CC\uFF0C\u4E0D\u4EA7\u751F\u51B3\u5B9A
  expires_at        INTEGER,
  result_work_item_id TEXT REFERENCES work_item(id),
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_proposal_open ON proposal(subject_key, kind, dedupe_key) WHERE status = 'open';

CREATE INDEX idx_proposal_decider ON proposal(decider_id, status);

CREATE TABLE decision (                  -- [P1] \u53EA\u8BB0\u7EC8\u6001\u51B3\u5B9A\uFF1B\u4E00\u6761\u63D0\u8BAE\u81F3\u591A\u4E00\u6761
  id                TEXT PRIMARY KEY,
  proposal_id       TEXT NOT NULL UNIQUE REFERENCES proposal(id),
  decided_by        TEXT NOT NULL REFERENCES member(id),
  decision          TEXT NOT NULL CHECK (decision IN ('accept','reject')),
  channel           TEXT NOT NULL CHECK (channel = 'ui'),
  note              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  CHECK (decision <> 'reject' OR length(note) > 0)
);

CREATE TABLE approval (                  -- [P1] \u4EBA\u7684\u4E00\u6B21\u628A\u5173
  id                TEXT PRIMARY KEY,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN
                     ('work_item_close','evidence_override','asset_disposal','skill_publish',
                      'target_change','permission_grant','project_archive')),
  subject_id        TEXT NOT NULL,                         -- \u524D\u4E09\u7C7B\u6307\u5411 work_item.id
  subject_revision  INTEGER NOT NULL,                      -- \u7533\u8BF7\u65F6\u5BF9\u8C61\u7684\u4FEE\u8BA2\u53F7
  execution_epoch   INTEGER NOT NULL DEFAULT 0,            -- \u4EC5\u5DE5\u4F5C\u9879\u7C7B\u5BA1\u6279\u4F7F\u7528
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- \u7533\u8BF7\u65F6\u9501\u5B9A\u7684\u8BC1\u636E\u96C6 / \u5185\u5BB9\u54C8\u5E0C
  criteria_ref      TEXT NOT NULL DEFAULT '',              -- \u5224\u636E\u7248\u672C\uFF1Awork_template_version.id \u7B49
  criteria_json     TEXT NOT NULL DEFAULT '{}',            -- \u5224\u636E\u9010\u6761\u7ED3\u679C\u5FEB\u7167\uFF0C\u4F9B\u754C\u9762\u5C55\u793A
  reason_text       TEXT NOT NULL,
  requested_by      TEXT NOT NULL REFERENCES member(id),
  requested_channel TEXT NOT NULL CHECK (requested_channel IN ('tool','ui','system')),
  approver_id       TEXT NOT NULL REFERENCES member(id),   -- \u7533\u8BF7\u65F6\u6309\u6A21\u677F\u9A8C\u6536\u7B56\u7565\u89E3\u6790\uFF0C\u4E0D\u7531\u7533\u8BF7\u65B9\u6311\u9009
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','returned',
                                      'expired','invalidated','withdrawn')),
  decided_by        TEXT REFERENCES member(id),
  decided_channel   TEXT CHECK (decided_channel IS NULL OR decided_channel = 'ui'),
  decision_note     TEXT NOT NULL DEFAULT '',
  decided_at        INTEGER,
  invalidated_reason TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK (status NOT IN ('rejected','returned') OR length(decision_note) > 0)
);

CREATE UNIQUE INDEX uq_approval_pending ON approval(subject_kind, subject_id) WHERE status = 'pending';

CREATE INDEX idx_approval_approver ON approval(approver_id, status, expires_at);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 7. \u8C03\u5EA6\u3001\u51FA\u7AD9\u3001\u5E42\u7B49\u4E0E\u5BA1\u8BA1 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE schedule (                  -- [P1] \u5468\u671F\u8BA1\u5212\uFF1B\u9010\u5355\u590D\u67E5\u8D70 work_item_check
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id),
  template_version_id TEXT REFERENCES work_template_version(id),
  member_id         TEXT REFERENCES member(id),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),
  kind              TEXT NOT NULL CHECK (kind IN ('at','every','cron')),
  spec              TEXT NOT NULL,
  timezone          TEXT NOT NULL,                         -- IANA \u65F6\u533A
  misfire_policy    TEXT NOT NULL DEFAULT 'catch_up_latest' CHECK (misfire_policy IN ('each','catch_up_latest','skip')),
  concurrency       TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency IN ('skip','queue','replace')),
  max_fires         INTEGER,
  fired_count       INTEGER NOT NULL DEFAULT 0,
  next_fire_at      INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_sched_next ON schedule(enabled, next_fire_at);

CREATE TABLE schedule_occurrence (       -- [P1] \u53CC\u89E6\u53D1\u9632\u91CD\u9760\u4E3B\u952E\uFF0C\u4E0D\u9760\u65F6\u95F4\u6BD4\u8F83
  schedule_id       TEXT NOT NULL REFERENCES schedule(id),
  planned_at        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'fired' CHECK (status IN ('fired','skipped','missed')),
  work_item_id      TEXT REFERENCES work_item(id),
  fired_at          INTEGER NOT NULL,                      -- \u5B9E\u9645\u6267\u884C\u65F6\u95F4
  PRIMARY KEY (schedule_id, planned_at)
);

CREATE TABLE outbox (                    -- [P1] \u53EA\u653E\u5BF9\u5916\u52A8\u4F5C\uFF1BHTTP \u547D\u4EE4\u5E42\u7B49\u5728 command_receipt
  id                TEXT PRIMARY KEY,
  action            TEXT NOT NULL,                         -- \u4F8B\uFF1Alark.notify / ticket.create
  payload_json      TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  work_item_id      TEXT REFERENCES work_item(id),
  execution_epoch   INTEGER,                               -- \u53D1\u9001\u524D\u4E0E\u5DE5\u4F5C\u9879\u5F53\u524D\u4EE3\u6B21\u6BD4\u5BF9
  approval_id       TEXT REFERENCES approval(id),
  requested_by      TEXT NOT NULL REFERENCES member(id),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','confirmed','unknown','cancelled','failed')),
  not_after         INTEGER,                               -- \u8FC7\u4E86\u5C31\u4E0D\u518D\u53D1
  available_at      INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  external_ref      TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  sending_at        INTEGER,
  finished_at       INTEGER
);

CREATE INDEX idx_outbox_due ON outbox(status, available_at);

CREATE TABLE command_receipt (           -- [P1] \u5199\u547D\u4EE4\u5E42\u7B49\uFF1A\u540C\u952E\u540C\u8F7D\u8377\u8FD4\u56DE\u9996\u6B21\u56DE\u6267
  scope_key         TEXT PRIMARY KEY,                      -- hash(principal + action + idempotencyKey)
  command_id        TEXT NOT NULL,
  principal_id      TEXT NOT NULL REFERENCES member(id),
  action            TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  receipt_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_receipt_age ON command_receipt(created_at);

CREATE TABLE change_log (                -- [P1] \u754C\u9762\u300C\u5FEB\u7167 + \u6E38\u6807\u300D\u7684\u6E38\u6807\u6765\u6E90
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  object_kind       TEXT NOT NULL,
  object_id         TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  change_kind       TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE tick_log (                  -- [P1]
  tick_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_epoch     INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  fired             INTEGER NOT NULL DEFAULT 0,
  recovered         INTEGER NOT NULL DEFAULT 0,
  error_text        TEXT
);

CREATE TABLE audit_log (                 -- [P1] \u8FFD\u52A0\u5F0F\u5BA1\u8BA1
  id                TEXT PRIMARY KEY,
  actor_id          TEXT NOT NULL REFERENCES member(id),
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','bot','system')),
  on_behalf_of      TEXT REFERENCES member(id),            -- \u4EE3\u5F55
  channel           TEXT NOT NULL CHECK (channel IN ('ui','tool','system','connector')),
  auth_subject      TEXT,                                  -- \u5BBF\u4E3B\u8D26\u53F7 / SSO \u4E3B\u4F53
  host_preset       TEXT,                                  -- \u5F53\u65F6\u7684\u5BBF\u4E3B\u6743\u9650\u9884\u8BBE\u540D\uFF1B\u8BFB\u4E0D\u5230\u8BB0 'unreadable'
  action            TEXT NOT NULL,
  subject_kind      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  before_json       TEXT,
  after_json        TEXT,
  correlation_id    TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_audit_subject ON audit_log(subject_kind, subject_id, created_at);

-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 9. \u89E6\u53D1\u5668\uFF1A\u628A\u6700\u8981\u7D27\u7684\u4E0D\u53D8\u91CF\u843D\u5728\u5E93\u91CC \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

-- 9.1 \u6388\u6743\uFF1A\u5BA1\u6279\u6743\u53EA\u80FD\u7ED9\u4EBA\uFF0C\u4E14\u53EA\u80FD\u7ECF\u5C97\u4F4D
CREATE TRIGGER trg_member_permission_bot_only BEFORE INSERT ON member_permission
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'bot'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: member_permission is for bots only'); END;

CREATE TRIGGER trg_bot_no_human_capability BEFORE INSERT ON member_permission
WHEN NEW.capability IN ('approval.decide','proposal.decide','work_item.close','skill.publish',
                        'target.publish','review.confirm','project.archive','member.manage','position.manage','permission.grant')
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: capability reserved for humans'); END;

CREATE TRIGGER trg_member_position_human_only BEFORE INSERT ON member_position
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: positions are for humans only'); END;

CREATE TRIGGER trg_hams_user_human_only BEFORE INSERT ON hams_user
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: login identity must bind a human member'); END;

-- 9.2 \u914D\u7F6E\u7248\u672C\u4E0D\u53EF\u53D8
CREATE TRIGGER trg_member_version_immutable BEFORE UPDATE ON member_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: member_version'); END;

CREATE TRIGGER trg_target_version_immutable BEFORE UPDATE ON project_target_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: project_target_version'); END;

-- 9.3 \u5DE5\u4F5C\u9879\uFF1A\u8D1F\u8D23\u4EBA\u5FC5\u987B\u662F\u4EBA\uFF1B\u8BA1\u6570\u5668\u53EA\u589E\uFF1B\u72B6\u6001\u53EA\u8D70\u767D\u540D\u5355\uFF1B\u6062\u590D\u53EA\u56DE\u5230\u6682\u505C\u524D\u72B6\u6001
CREATE TRIGGER trg_wi_owner_human_ins BEFORE INSERT ON work_item
WHEN (SELECT kind FROM member WHERE id = NEW.owner_human_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: work item owner must be human'); END;

CREATE TRIGGER trg_wi_owner_human_upd BEFORE UPDATE OF owner_human_id ON work_item
WHEN (SELECT kind FROM member WHERE id = NEW.owner_human_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: work item owner must be human'); END;

CREATE TRIGGER trg_wi_counters_monotonic BEFORE UPDATE ON work_item
WHEN NEW.revision <= OLD.revision OR NEW.execution_epoch < OLD.execution_epoch OR NEW.fence_seq < OLD.fence_seq
BEGIN SELECT RAISE(ABORT, 'VERSION_CONFLICT: every write must bump revision; counters never go back'); END;

CREATE TRIGGER trg_wi_transition_whitelist BEFORE UPDATE OF status ON work_item
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM work_item_transition t WHERE t.from_status = OLD.status AND t.to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: transition not in whitelist'); END;

CREATE TRIGGER trg_wi_resume_target BEFORE UPDATE OF status ON work_item
WHEN OLD.status = 'paused' AND NEW.status NOT IN ('paused','cancelled') AND NEW.status IS NOT OLD.resume_state
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: resume must return to the state before pause'); END;

CREATE TRIGGER trg_wi_epoch_on_pause BEFORE UPDATE OF status ON work_item
WHEN NEW.status <> OLD.status
     AND (NEW.status IN ('paused','cancelled') OR OLD.status IN ('paused','completed','failed'))
     AND NEW.execution_epoch = OLD.execution_epoch
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: pause/resume/cancel/reopen/retry must bump execution_epoch'); END;

CREATE TRIGGER trg_wi_epoch_on_reassign BEFORE UPDATE OF assignee_id ON work_item
WHEN OLD.assignee_id IS NOT NULL AND NEW.assignee_id IS NOT OLD.assignee_id
     AND NEW.execution_epoch = OLD.execution_epoch
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: changing the executor must bump execution_epoch'); END;

-- 9.4 \u5173\u5355\uFF1A\u6709\u6548\u5BA1\u6279\uFF08\u4EBA\u5DE5\u8DEF\u5F84\uFF09\u6216\u901A\u8FC7\u7684\u590D\u67E5\uFF08\u5DF2\u6388\u6743\u81EA\u52A8\u5173\u5355\uFF09\uFF0C\u4E8C\u8005\u90FD\u9501\u5B9A\u4EE3\u6B21\u4E0E\u8BC1\u636E\u96C6
CREATE TRIGGER trg_wi_complete_guard BEFORE UPDATE OF status ON work_item
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND (
  (NEW.close_requires_approval = 1 AND NOT EXISTS (
     SELECT 1 FROM approval a
      WHERE a.subject_kind = 'work_item_close' AND a.subject_id = OLD.id AND a.status = 'approved'
        AND a.subject_revision = OLD.revision AND a.execution_epoch = OLD.execution_epoch
        AND a.evidence_set_hash = OLD.evidence_set_hash))
  OR
  (NEW.close_requires_approval = 0 AND NOT EXISTS (
     SELECT 1 FROM work_item_check c
      WHERE c.work_item_id = OLD.id AND c.status = 'passed'
        AND c.execution_epoch = OLD.execution_epoch AND c.evidence_set_hash = OLD.evidence_set_hash))
)
BEGIN SELECT RAISE(ABORT, 'APPROVAL_REQUIRED: close needs a valid approval or a passed check on the same evidence'); END;

-- 9.5 \u5DE5\u4F5C\u9879\u6216\u8BC1\u636E\u4E00\u53D8\uFF0C\u5F85\u51B3\u7684\u5BA1\u6279\u7ACB\u5373\u4F5C\u5E9F
CREATE TRIGGER trg_wi_change_invalidates_approval AFTER UPDATE OF revision ON work_item
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE approval SET status = 'invalidated', invalidated_reason = 'subject_changed'
   WHERE subject_kind IN ('work_item_close','evidence_override','asset_disposal') AND subject_id = NEW.id
     AND status = 'pending' AND subject_revision <> NEW.revision;
END;

-- \u8BC1\u636E\u65B0\u589E\u6216\u72B6\u6001\u53D8\u5316\u90FD\u4F1A\u9012\u589E\u5DE5\u4F5C\u9879\u4FEE\u8BA2\u53F7\uFF1A\u5F85\u51B3\u5BA1\u6279\u7ECF\u4E0A\u4E00\u6761\u89E6\u53D1\u5668\u4F5C\u5E9F\uFF0C
-- \u5DF2\u6279\u51C6\u4F46\u5C1A\u672A\u5173\u5355\u7684\u5BA1\u6279\u4E5F\u56E0\u4FEE\u8BA2\u53F7\u4E0D\u518D\u5339\u914D\u800C\u65E0\u6CD5\u7528\u4E8E\u5173\u5355\uFF089.4\uFF09\u3002\u8BC1\u636E\u96C6\u54C8\u5E0C\u7531\u670D\u52A1\u5728\u540C\u4E00\u4E8B\u52A1\u91CD\u7B97\u3002
CREATE TRIGGER trg_evidence_insert_bumps_revision AFTER INSERT ON evidence
BEGIN
  UPDATE work_item SET revision = revision + 1, updated_at = NEW.captured_at WHERE id = NEW.work_item_id;
END;

CREATE TRIGGER trg_evidence_status_bumps_revision AFTER UPDATE OF status ON evidence
WHEN NEW.status <> OLD.status
BEGIN
  UPDATE work_item SET revision = revision + 1 WHERE id = NEW.work_item_id;
END;

CREATE TRIGGER trg_evidence_immutable BEFORE UPDATE OF work_item_id, kind, ref, content_hash, observed_at, captured_by ON evidence
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: evidence facts are append-only'); END;

CREATE TRIGGER trg_evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: evidence rows are never deleted'); END;

-- 9.6 \u5BA1\u6279\uFF1A\u5BA1\u6279\u4EBA\u4E0E\u51B3\u5B9A\u4EBA\u5FC5\u987B\u662F\u4EBA\u3001\u8D70\u754C\u9762\u3001\u662F\u6307\u5B9A\u5BA1\u6279\u4EBA\u3001\u672A\u8FC7\u671F\uFF1B\u7EC8\u6001\u4E0D\u53EF\u518D\u6539
CREATE TRIGGER trg_approval_approver_human_ins BEFORE INSERT ON approval
WHEN (SELECT kind FROM member WHERE id = NEW.approver_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: approver must be human'); END;

CREATE TRIGGER trg_approval_approver_human_upd BEFORE UPDATE OF approver_id ON approval
WHEN (SELECT kind FROM member WHERE id = NEW.approver_id) IS NOT 'human' OR OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: approver must be human and approval still pending'); END;

CREATE TRIGGER trg_approval_terminal BEFORE UPDATE OF status ON approval
WHEN OLD.status <> 'pending' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: approval already decided'); END;

CREATE TRIGGER trg_approval_decision_guard BEFORE UPDATE OF status ON approval
WHEN NEW.status IN ('approved','rejected','returned') AND (
     NEW.decided_by IS NULL
  OR NEW.decided_by <> OLD.approver_id
  OR NEW.decided_channel IS NOT 'ui'
  OR NEW.decided_at IS NULL
  OR NEW.decided_at >= OLD.expires_at
  OR (SELECT kind FROM member WHERE id = NEW.decided_by) IS NOT 'human')
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: decision must come from the designated human approver via UI before expiry'); END;

-- 9.7 \u63D0\u8BAE\u53EA\u80FD\u7531 bot \u53D1\uFF0C\u51B3\u5B9A\u53EA\u80FD\u7531\u4EBA\u505A
CREATE TRIGGER trg_proposal_by_bot BEFORE INSERT ON proposal
WHEN (SELECT kind FROM member WHERE id = NEW.proposed_by) IS NOT 'bot'
  OR (SELECT kind FROM member WHERE id = NEW.decider_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: proposals come from bots and are decided by humans'); END;

CREATE TRIGGER trg_decision_by_human BEFORE INSERT ON decision
WHEN (SELECT kind FROM member WHERE id = NEW.decided_by) IS NOT 'human'
  OR NEW.decided_by IS NOT (SELECT decider_id FROM proposal WHERE id = NEW.proposal_id)
  OR (SELECT status FROM proposal WHERE id = NEW.proposal_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: decision must come from the designated human on an open proposal'); END;

-- 9.8 \u8FD0\u884C\uFF1A\u5FC5\u987B\u843D\u5728\u540C\u4E00\u5DE5\u4F5C\u9879\u300C\u5728\u7528\u300D\u7684\u4F1A\u8BDD\u4EE3\u6B21\u4E0A\uFF0C\u4E14\u4EE3\u6B21\u662F\u5F53\u524D\u7684\uFF1B\u79DF\u7EA6\u53EA\u7ED9 bot
CREATE TRIGGER trg_run_binds_current_thread BEFORE INSERT ON task_run
WHEN NOT EXISTS (SELECT 1 FROM work_item_thread t
                  WHERE t.id = NEW.thread_id AND t.work_item_id = NEW.work_item_id
                    AND t.status = 'active' AND t.member_id = NEW.member_id)
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: run must bind the active thread of the same work item and bot'); END;

CREATE TRIGGER trg_run_epoch_current BEFORE INSERT ON task_run
WHEN NEW.execution_epoch IS NOT (SELECT execution_epoch FROM work_item WHERE id = NEW.work_item_id)
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: run must carry the current execution_epoch'); END;

CREATE TRIGGER trg_lease_bot_only BEFORE INSERT ON lease
WHEN (SELECT kind FROM member WHERE id = NEW.holder_member_id) IS NOT 'bot'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: leases are for bot runs only'); END;

-- 9.10 \u65F6\u95F4\u7EBF\u4E0E\u5BA1\u8BA1\u53EA\u8FFD\u52A0\uFF08\u6309\u6708\u5F52\u6863\u7531\u8FC1\u79FB\u6B65\u9AA4\u5728\u540C\u4E00\u4E8B\u52A1\u5185\u4E34\u65F6\u89E3\u9664\u540E\u6062\u590D\uFF09
CREATE TRIGGER trg_event_no_update BEFORE UPDATE ON work_item_event
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: work_item_event'); END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: audit_log'); END;

CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: audit_log'); END;
`;
var P1_SCHEMA_META = {
  authority: "docs/schema-2026-11-14.sql",
  authoritySha256: "91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7",
  tables: 41,
  indexes: 30,
  triggers: 31,
  inserts: 2,
  p2Tables: 14,
  shellTables: 2,
  tableNames: ["hams_meta", "member", "member_version", "member_permission", "member_tool_policy", "hams_user", "position", "position_permission", "member_position", "project", "project_target_version", "project_metric", "project_budget", "metric_observation", "asset", "ledger_snapshot", "work_template", "work_template_version", "event_inbox", "work_item_transition", "work_item", "work_item_relation", "work_item_event", "work_item_thread", "work_item_check", "task_run", "run_step", "lease", "evidence", "handoff", "attention_item", "proposal", "decision", "approval", "schedule", "schedule_occurrence", "outbox", "command_receipt", "change_log", "tick_log", "audit_log"]
};

// src/store/schema/002_knowledge.sql.ts
var KNOWLEDGE_SCHEMA_SQL = `-- \u26A0\uFE0F \u81EA\u52A8\u751F\u6210\uFF0C\u8BF7\u52FF\u624B\u6539\u3002
-- \u6765\u6E90\uFF08\u6743\u5A01\uFF09\uFF1Adocs/schema-2026-11-14.sql
-- \u6743\u5A01\u6587\u4EF6 sha256\uFF1A91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7
-- \u751F\u6210\u547D\u4EE4\uFF1Anode scripts/split-schema.mjs
-- \u5185\u5BB9\uFF1Av2 \u77E5\u8BC6 4 \u8868 / 0 \u7D22\u5F15 / 0 \u89E6\u53D1\u5668 / 0 \u79CD\u5B50\u8BED\u53E5
-- \u5206\u671F\u4F9D\u636E\uFF1A\u6743\u5A01 DDL \u91CC [P2] \u4E14\u8868\u540D\u5C5E\u4E8E\u77E5\u8BC6\u5B50\u96C6\u7684\u8868\uFF1Bv1 \u5DF2\u5EFA\u7684 41 \u5F20 P1 \u8868\u4E0D\u91CD\u590D\u3002
-- \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 2. \u77E5\u8BC6 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE kb_table (                  -- [P2]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('hive','lark_base','local','webhook')),
  source_ref        TEXT,
  schema_json       TEXT NOT NULL,
  field_map_status  TEXT NOT NULL DEFAULT 'ok' CHECK (field_map_status IN ('ok','missing')),
  updated_at        INTEGER NOT NULL
);

CREATE TABLE kb_doc (                    -- [P2]
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body_ref          TEXT NOT NULL,                   -- \u7EDD\u5BF9\u8DEF\u5F84\u6216 URL\uFF1B\u9762\u677F\u5185\u64B0\u5199\u7684\u843D\u5728 hams/knowledge/docs
  revision          INTEGER NOT NULL DEFAULT 1,
  owner_id          TEXT NOT NULL REFERENCES member(id),
  source_kind       TEXT NOT NULL DEFAULT 'hams'
                    CHECK (source_kind IN ('hams','file')),   -- hams=\u9762\u677F\u5185\u64B0\u5199\uFF1Bfile=\u5BFC\u5165\u7684\u672C\u5730\u6587\u4EF6
  content_hash      TEXT NOT NULL DEFAULT '',        -- sha256(\u539F\u6587)\uFF0C\u7528\u4E8E\u5224\u65AD\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u662F\u5426\u88AB\u5916\u90E8\u6539\u52A8
  bytes             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
  updated_at        INTEGER NOT NULL
);

CREATE TABLE kb_skill (                  -- [P2]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  domain            TEXT,
  published_version_id TEXT REFERENCES kb_skill_version(id),  -- NULL = \u5C1A\u65E0\u5DF2\u53D1\u5E03\u7248\u672C
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE kb_skill_version (          -- [P2] \u53D1\u5E03\u8D70 approval(subject_kind='skill_publish')
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL REFERENCES kb_skill(id),
  version           TEXT NOT NULL,
  manifest_json     TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','in_review','published','retired')),
  authored_by       TEXT NOT NULL REFERENCES member(id),
  published_by      TEXT REFERENCES member(id),
  published_at      INTEGER,
  UNIQUE (skill_id, version)
);
`;
var KNOWLEDGE_SCHEMA_META = {
  authority: "docs/schema-2026-11-14.sql",
  authoritySha256: "91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7",
  tables: 4,
  tableNames: ["kb_table", "kb_doc", "kb_skill", "kb_skill_version"]
};

// src/store/migrations.ts
var MIGRATIONS = Object.freeze([
  { version: 1, name: "p1-baseline", sql: P1_SCHEMA_SQL },
  // v2：知识的四张表（kb_table / kb_doc / kb_skill / kb_skill_version）。
  // 从权威 DDL 的 [P2] 知识子集生成，不手抄；界面「知识」屏需要真实落库才能接版本与发布。
  { version: 2, name: "knowledge", sql: KNOWLEDGE_SCHEMA_SQL },
  { version: 3, name: "project-lifecycle", sql: PROJECTS_SCHEMA_SQL },
  // v4：项目群团队（参与者 / 合并消息 / 会话游标）+ 临时 bot 的归属列。
  { version: 4, name: "project-team", sql: TEAM_SCHEMA_SQL },
  // v5：阶段目标的检验提交记录（项目经理提交结果 + 报告链接）。
  { version: 5, name: "target-check", sql: TARGET_CHECK_SCHEMA_SQL },
  // v6：目标详情字段 + 检验提交的审批字段（提交检验走审批，不再直接生成结果）。
  { version: 6, name: "target-flow", sql: TARGET_FLOW_SCHEMA_SQL },
  // v7：归档项目的「删除」标记（软删；工作项解绑保留，审计与证据不动）。
  { version: 7, name: "project-delete", sql: PROJECT_DELETE_SCHEMA_SQL },
  // v8：项目记忆（自动/手工/工具收集）+ 能力类记忆同步给 bot。
  { version: 8, name: "project-memory", sql: MEMORY_SCHEMA_SQL },
  // v9：bot 每个配置版本的人设提示词（运行中创建的 bot 也能改提示词）。
  { version: 9, name: "bot-prompt", sql: BOT_PROMPT_SCHEMA_SQL }
]);
var TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
var SchemaTooNewError = class extends StoreError {
  found;
  supported;
  constructor(found, supported) {
    super(
      "SCHEMA_TOO_NEW",
      `\u6570\u636E\u5E93\u7248\u672C ${found} \u9AD8\u4E8E\u4EE3\u7801\u652F\u6301\u7684\u4E0A\u9650 ${supported}\uFF1B\u62D2\u7EDD\u542F\u52A8\uFF0C\u907F\u514D\u65E7\u4EE3\u7801\u6539\u574F\u65B0\u5E93`
    );
    this.found = found;
    this.supported = supported;
  }
};
var SchemaIncompleteError = class extends StoreError {
  missing;
  constructor(missing) {
    super("SCHEMA_INCOMPLETE", `user_version \u5DF2\u662F\u5F53\u524D\u7248\u672C\uFF0C\u4F46\u7F3A\u5C11\u57FA\u7EBF\u8868\uFF1A${missing.join(", ")}`);
    this.missing = missing;
  }
};
function tablesUpTo(version) {
  const tables = [...P1_SCHEMA_META.tableNames];
  if (version >= 2) tables.push(...KNOWLEDGE_SCHEMA_META.tableNames);
  if (version >= 3) tables.push(...PROJECTS_SCHEMA_META.tableNames);
  if (version >= 4) tables.push(...TEAM_SCHEMA_META.tableNames);
  if (version >= 5) tables.push(...TARGET_CHECK_SCHEMA_META.tableNames);
  if (version >= 6) tables.push(...TARGET_FLOW_SCHEMA_META.tableNames);
  return tables;
}
function validateChain(migrations) {
  if (migrations.length === 0) throw new StoreError("BAD_MIGRATIONS", "\u8FC1\u79FB\u94FE\u4E3A\u7A7A");
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new StoreError(
        "BAD_MIGRATIONS",
        `\u8FC1\u79FB\u94FE\u5FC5\u987B\u4ECE 1 \u8FDE\u7EED\u9012\u589E\uFF1A\u671F\u671B ${expected}\uFF0C\u6536\u5230 ${migration.version}\uFF08${migration.name}\uFF09`
      );
    }
    if (!migration.sql.trim()) throw new StoreError("BAD_MIGRATIONS", `\u8FC1\u79FB ${migration.version} \u7684 SQL \u4E3A\u7A7A`);
    expected += 1;
  }
}
function pendingMigrations(current, migrations = MIGRATIONS) {
  return migrations.filter((migration) => migration.version > current);
}
function migrate(db, options = {}) {
  const migrations = options.migrations ?? MIGRATIONS;
  const useBuiltin = migrations === MIGRATIONS;
  const verifyBaseline = options.verifyBaseline ?? useBuiltin;
  validateChain(migrations);
  const target = migrations[migrations.length - 1].version;
  const from = userVersion(db);
  if (from > target) throw new SchemaTooNewError(from, target);
  const pending2 = pendingMigrations(from, migrations);
  const applied = [];
  if (from >= 1 && verifyBaseline && useBuiltin) {
    const expected = tablesUpTo(from);
    const present = new Set(tableNames(db));
    const missing = expected.filter((name2) => !present.has(name2));
    if (missing.length) throw new SchemaIncompleteError(missing);
  }
  for (const migration of pending2) {
    transaction(db, () => {
      db.exec(migration.sql);
      setUserVersion(db, migration.version);
      if (tableNames(db).includes("hams_meta")) {
        db.prepare(
          `INSERT INTO hams_meta (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(String(migration.version));
      }
    });
    applied.push({ version: migration.version, name: migration.name });
  }
  let checkedBaseline = false;
  if (verifyBaseline && useBuiltin) {
    const present = new Set(tableNames(db));
    const missing = tablesUpTo(target).filter((name2) => !present.has(name2));
    if (missing.length) throw new SchemaIncompleteError([...missing]);
    checkedBaseline = true;
  }
  return {
    fromVersion: from,
    toVersion: userVersion(db),
    applied,
    migrated: applied.length > 0,
    checkedBaseline
  };
}

// src/store/seed.ts
var META_KEYS = [
  "schema_version",
  "runtime_epoch",
  "primary_workspace_id",
  "last_tick_at",
  "bootstrapped_at"
];
var SeedError = class extends StoreError {
  constructor(message, code = "SEED_INVALID") {
    super(code, message);
    this.name = "SeedError";
  }
};
function readMeta(db) {
  const rows = db.prepare("SELECT key, value FROM hams_meta").all();
  const meta = {};
  for (const row of rows) meta[row.key] = row.value;
  return meta;
}
function ensureMetaDefaults(db, options = {}) {
  const now = options.now ?? Date.now();
  const defaults = {
    schema_version: String(userVersion(db)),
    runtime_epoch: "0",
    primary_workspace_id: "",
    last_tick_at: "0",
    bootstrapped_at: String(now)
  };
  return transaction(db, () => {
    const insert = db.prepare("INSERT OR IGNORE INTO hams_meta (key, value) VALUES (?, ?)");
    for (const key of META_KEYS) insert.run(key, defaults[key]);
    const update = db.prepare("UPDATE hams_meta SET value = ? WHERE key = ?");
    update.run(String(userVersion(db)), "schema_version");
    return readMeta(db);
  });
}
function bumpRuntimeEpoch(db) {
  return transaction(db, () => {
    const row = db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get();
    const current = Number(row?.value ?? 0);
    const next = (Number.isFinite(current) && current >= 0 ? current : 0) + 1;
    db.prepare(
      `INSERT INTO hams_meta (key, value) VALUES ('runtime_epoch', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(next));
    return next;
  });
}
function assertBaselineSeed(db) {
  const system = db.prepare("SELECT COUNT(*) AS c FROM member WHERE kind = 'system' AND id = 'system'").get();
  const transitions = db.prepare("SELECT COUNT(*) AS c FROM work_item_transition").get().c;
  const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().c;
  if (Number(system.c) !== 1) {
    throw new SeedError(`\u7CFB\u7EDF\u4E3B\u4F53\u5E94\u552F\u4E00\u5B58\u5728\u4E00\u884C\uFF0C\u5B9E\u9645 ${system.c} \u884C\uFF1B\u62D2\u7EDD\u63A5\u6D41\u91CF`);
  }
  if (Number(transitions) !== 36) {
    throw new SeedError(`\u72B6\u6001\u8F6C\u6362\u767D\u540D\u5355\u5E94\u6709 36 \u6761\uFF0C\u5B9E\u9645 ${transitions} \u6761\uFF1B\u62D2\u7EDD\u63A5\u6D41\u91CF`);
  }
  return { systemMember: true, transitions: Number(transitions), tables: Number(tables) };
}

// src/store/bootstrap.ts
function toBackupSummary(report) {
  if (!report) return null;
  return { name: report.name, path: report.path, bytes: report.bytes, tables: report.tables };
}
function bootstrapStore(options = {}) {
  const now = options.now ?? Date.now;
  const migrations = options.migrations ?? MIGRATIONS;
  const targetVersion = migrations[migrations.length - 1].version;
  const dataDir = resolveDataDir(options.dataDir);
  const dbPath = databasePath(dataDir);
  const steps = [];
  const lock = acquireLock(dataDir, { staleMs: options.staleMs, now: now() });
  steps.push("acquire-lock");
  let db = null;
  try {
    db = openDatabase({ path: dbPath });
    steps.push("open-db");
    const fromVersion = userVersion(db);
    let backupReport = null;
    if (fromVersion > 0 && fromVersion < targetVersion && options.backupBeforeMigrate !== false) {
      backupReport = createBackup(db, {
        dir: backupDir(dataDir),
        keep: options.backupKeep,
        now: new Date(now())
      });
      steps.push(`backup-before-migrate:${backupReport.name}`);
    } else if (fromVersion === 0) {
      steps.push("skip-backup-fresh-db");
    } else {
      steps.push("skip-backup-no-upgrade");
    }
    const migrationReport = migrate(db, {
      migrations,
      verifyBaseline: options.verifyBaseline ?? migrations === MIGRATIONS
    });
    steps.push(
      migrationReport.migrated ? `migrate:${migrationReport.applied.map((item) => item.version).join(",")}` : "migrate:noop"
    );
    ensureMetaDefaults(db, { now: now() });
    steps.push("seed-meta");
    const seed = assertBaselineSeed(db);
    steps.push("assert-baseline-seed");
    const runtimeEpoch = bumpRuntimeEpoch(db);
    steps.push(`bump-runtime-epoch:${runtimeEpoch}`);
    const finalMeta = readMeta(db);
    const report = {
      dataDir,
      dbPath,
      lockPath: lockPath(dataDir),
      fromVersion,
      toVersion: migrationReport.toVersion,
      runtimeEpoch,
      backup: toBackupSummary(backupReport),
      migration: {
        migrated: migrationReport.migrated,
        applied: migrationReport.applied,
        checkedBaseline: migrationReport.checkedBaseline
      },
      seed,
      meta: finalMeta,
      steps
    };
    let closed = false;
    const runtime = {
      dataDir,
      dbPath,
      db,
      lock,
      report,
      get closed() {
        return closed;
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          closeDatabase(db);
        } finally {
          lock.release();
        }
      }
    };
    return runtime;
  } catch (error) {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
      }
    }
    lock.release();
    throw error;
  }
}
function openReadOnlyStore(dataDir, expectedVersion = TARGET_VERSION) {
  const resolved = resolveDataDir(dataDir);
  const db = openDatabase({ path: databasePath(resolved), readOnly: true });
  const version = userVersion(db);
  if (version > expectedVersion) {
    closeDatabase(db);
    throw new SchemaTooNewError(version, expectedVersion);
  }
  if (version < expectedVersion) {
    closeDatabase(db);
    throw new StoreError(
      "SCHEMA_OUTDATED",
      `\u53EA\u8BFB\u5B9E\u4F8B\u9047\u5230\u65E7\u7248\u672C\u5E93 ${version} < ${expectedVersion}\uFF1B\u8BF7\u5148\u7528\u53EF\u5199\u5B9E\u4F8B\u5B8C\u6210\u8FC1\u79FB`
    );
  }
  let closed = false;
  return {
    dataDir: resolved,
    db,
    userVersion: version,
    close() {
      if (closed) return;
      closed = true;
      closeDatabase(db);
    }
  };
}
var P1_TABLE_COUNT = P1_SCHEMA_META.tables;

// src/domain/errors.ts
var HamsError = class extends Error {
  code;
  nextStep;
  detail;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "HamsError";
    this.code = code;
    this.nextStep = options.nextStep;
    this.detail = options.detail;
  }
};
function denied(message, nextStep) {
  return new HamsError("POLICY_DENIED", message, { nextStep });
}
function stateInvalid(message, nextStep) {
  return new HamsError("STATE_INVALID", message, { nextStep });
}
function evidenceIncomplete(message, detail) {
  return new HamsError("EVIDENCE_INCOMPLETE", message, {
    detail,
    nextStep: "\u8865\u9F50\u7F3A\u7684\u8BC1\u636E\u540E\u91CD\u65B0\u7533\u8BF7"
  });
}

// src/service/defaults.ts
import { createHash as createHash2 } from "node:crypto";
var DEFAULT_COORDINATOR_NAME = "\u9879\u76EE\u7BA1\u7406";
var DEFAULT_ANALYST_NAME = "\u6570\u636E\u5206\u6790";
var DEFAULT_COORDINATOR_ID = "bot-pm";
var DEFAULT_ANALYST_ID = "bot-data";
var DEFAULT_BOTS = Object.freeze([
  {
    id: DEFAULT_COORDINATOR_ID,
    name: DEFAULT_COORDINATOR_NAME,
    domain: "\u901A\u7528",
    role: "coordinator",
    responsibility: "\u65B0\u9879\u76EE\u9ED8\u8BA4\u63A8\u8FDB bot\uFF1A\u628A\u76EE\u6807\u62C6\u6210\u5DE5\u4F5C\u9879\u3001\u5728\u9879\u76EE\u7FA4\u91CC @ \u5177\u4F53\u6210\u5458\u6D3E\u6D3B\u3001\u6C47\u603B\u8FDB\u5C55\uFF1B\u6539\u76EE\u6807\u53E3\u5F84\u3001\u5BA1\u6279\u4E0E\u5173\u5355\u4ECD\u7531\u4EBA\u505A\u3002",
    capabilities: [
      "work_item.claim",
      "work_item.execute",
      "work_item.request_closure",
      "evidence.append",
      "check.evaluate",
      "proposal.create"
    ]
  },
  {
    id: DEFAULT_ANALYST_ID,
    name: DEFAULT_ANALYST_NAME,
    domain: "\u901A\u7528",
    role: "executor",
    responsibility: "\u9ED8\u8BA4\u6570\u636E\u5206\u6790 bot\uFF1A\u67E5\u6307\u6807\u4E0E\u5DE5\u4F5C\u9879\u6570\u636E\u3001\u505A\u5BF9\u6BD4\u3001\u7ED9\u7ED3\u8BBA\u5E76\u767B\u8BB0\u8BC1\u636E\uFF1B\u4E0D\u4E0B\u5E02\u573A\u5224\u65AD\u3001\u4E0D\u6279\u51C6\u5173\u5355\u3002",
    capabilities: [
      "work_item.claim",
      "work_item.execute",
      "evidence.append",
      "metric.record",
      "connector.ingest"
    ]
  }
]);
function findBot(db, spec) {
  return db.prepare(
    `SELECT id, name, kind, status FROM member
        WHERE id = ? OR (name = ? AND scope_project_id IS NULL)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`
  ).get(spec.id, spec.name, spec.id);
}
function findDefaultBot(db, key) {
  const spec = key === "coordinator" ? DEFAULT_BOTS[0] : DEFAULT_BOTS[1];
  const row = findBot(db, spec);
  return row && row.kind === "bot" && row.status === "active" ? row : null;
}
function defaultCoordinatorId(db) {
  return findDefaultBot(db, "coordinator")?.id ?? null;
}
function ensureDefaultBots(db, ids, now, ownerHumanId) {
  const owner = db.prepare("SELECT id, kind, status FROM member WHERE id = ?").get(ownerHumanId);
  if (!owner || owner.kind !== "human" || owner.status !== "active") {
    throw stateInvalid("\u9ED8\u8BA4 bot \u7684\u8D23\u4EFB\u4EBA\u5FC5\u987B\u662F\u672C\u673A\u5728\u5C97\u7684\u4EBA");
  }
  const result = { created: [], existing: [] };
  const insertMember2 = db.prepare(
    `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                         owner_human_id, created_at, updated_at)
     VALUES (?, 'bot', ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
  );
  const insertVersion = db.prepare(
    `INSERT INTO member_version
       (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
        change_class, published_by, published_at)
     VALUES (?, ?, 1, 'hams-bot', NULL, '{}', ?, ?, 'major', ?, ?)`
  );
  const grant = db.prepare(
    "INSERT OR IGNORE INTO member_permission (member_id, capability, scope, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const spec of DEFAULT_BOTS) {
    const existing = findBot(db, spec);
    if (existing) {
      result.existing.push({ key: spec.id, id: existing.id, name: existing.name });
      continue;
    }
    const digest = createHash2("sha256").update(`${spec.name}
${spec.responsibility}`).digest("hex").slice(0, 16);
    insertMember2.run(
      spec.id,
      spec.name,
      spec.domain,
      spec.responsibility,
      spec.role,
      ownerHumanId,
      now,
      now
    );
    insertVersion.run(ids(), spec.id, spec.responsibility, digest, ownerHumanId, now);
    for (const capability of spec.capabilities) grant.run(spec.id, capability, "global", ownerHumanId, now);
    result.created.push({ key: spec.id, id: spec.id, name: spec.name });
  }
  return result;
}
function ensureDefaultAnalystInProject(db, projectId, coordinatorId, addedBy, now) {
  const analyst = findDefaultBot(db, "analyst");
  if (!analyst || analyst.id === coordinatorId) return { added: false, memberId: null };
  const project = db.prepare("SELECT id, status FROM project WHERE id = ? AND deleted_at IS NULL").get(projectId);
  if (!project) return { added: false, memberId: null };
  const existing = db.prepare("SELECT removed_at FROM project_participant WHERE project_id = ? AND member_id = ?").get(projectId, analyst.id);
  if (existing && existing.removed_at === null) return { added: false, memberId: analyst.id };
  db.prepare(
    `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
     VALUES (?, ?, 'member', ?, ?, ?, NULL, NULL)
     ON CONFLICT(project_id, member_id) DO UPDATE SET
       kind = 'member', brief = excluded.brief, added_by = excluded.added_by,
       added_at = excluded.added_at, removed_by = NULL, removed_at = NULL`
  ).run(projectId, analyst.id, "\u9ED8\u8BA4\u6570\u636E\u5206\u6790\uFF1A\u67E5\u6307\u6807\u4E0E\u5DE5\u4F5C\u9879\u6570\u636E\uFF0C\u51FA\u7ED3\u8BBA\u3002", addedBy, now);
  return { added: true, memberId: analyst.id };
}

// src/service/projects.ts
var PROJECT_TYPES = ["one_off", "continuous"];
var PROJECT_STATUSES = ["draft", "active", "paused", "archived"];
var METRIC_DIRECTIONS = ["higher", "lower", "range"];
var METRIC_WINDOWS = ["day", "week", "month", "snapshot"];
var MAX_NAME = 80;
var MAX_GOAL = 4e3;
var MAX_METRICS = 12;
var MAX_METRIC_NAME = 40;
function text(value, field, max = MAX_NAME, allowEmpty = false) {
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw stateInvalid(`${field} \u4E0D\u80FD\u4E3A\u7A7A`);
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function optionalText(value, field, max = MAX_NAME) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function finiteNumber(value, field) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw stateInvalid(`${field} \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57`);
  return value;
}
function oneOf(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw stateInvalid(`${field} \u53EA\u80FD\u662F ${allowed.join(" / ")}`);
  }
  return value;
}
function statusMap(db, projectIds) {
  const result = /* @__PURE__ */ new Map();
  if (!projectIds.length) return result;
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT project_id, status, COUNT(*) AS c FROM work_item
        WHERE project_id IN (${placeholders})
        GROUP BY project_id, status`
  ).all(...projectIds);
  for (const row of rows) {
    const bucket = result.get(row.project_id) ?? {};
    bucket[row.status] = Number(row.c);
    result.set(row.project_id, bucket);
  }
  return result;
}
function listProjects(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.projectId) {
    clauses.push("p.id = ?");
    params.push(filter.projectId);
  }
  if (filter.status) {
    clauses.push("p.status = ?");
    params.push(filter.status);
  }
  if (filter.type) {
    clauses.push("p.type = ?");
    params.push(filter.type);
  }
  const where = `WHERE p.deleted_at IS NULL${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}`;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);
  const rows = db.prepare(
    `SELECT p.*, o.name AS owner_name, c.name AS coordinator_name,
              (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id) AS item_total,
              (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id
                 AND w.status NOT IN ('completed','cancelled','failed')) AS item_open,
              (SELECT COUNT(*) FROM project_metric m JOIN project_target_version t ON t.id=m.version_id WHERE m.project_id = p.id AND t.version=p.current_target_version) AS metric_count,
              (SELECT COUNT(*) FROM project_metric m
                 JOIN metric_observation ob ON ob.metric_id = m.id
                WHERE m.project_id = p.id) AS observation_count,
              (SELECT COUNT(*) FROM project_memory pm
                WHERE pm.project_id = p.id AND pm.status = 'active') AS memory_count
         FROM project p
         LEFT JOIN member o ON o.id = p.owner_human_id
         LEFT JOIN member c ON c.id = p.coordinator_id
         ${where}
        ORDER BY p.updated_at DESC
        LIMIT ${limit}`
  ).all(...params);
  const byProject = statusMap(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    owner_human_id: row.owner_human_id,
    owner_name: row.owner_name,
    coordinator_id: row.coordinator_id,
    coordinator_name: row.coordinator_name,
    goal_text: row.goal_text,
    current_target_version: Number(row.current_target_version),
    revision: Number(row.revision),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    work_items: {
      total: Number(row.item_total),
      open: Number(row.item_open),
      byStatus: byProject.get(row.id) ?? {}
    },
    metric_count: Number(row.metric_count),
    observation_count: Number(row.observation_count),
    memory_count: Number(row.memory_count)
  }));
}
function getProject(db, projectId) {
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get(projectId);
  if (!row) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`);
  if (row.deleted_at) throw stateInvalid("\u9879\u76EE\u5DF2\u5220\u9664\uFF0C\u4E0D\u518D\u51FA\u73B0\u5728\u5DE5\u4F5C\u53F0\u91CC", "\u5237\u65B0\u9879\u76EE\u5217\u8868");
  const summary = listProjects(db, { projectId, limit: 1 }).find((item) => item.id === projectId);
  if (!summary) throw stateInvalid(`\u9879\u76EE\u8BFB\u6A21\u578B\u7F3A\u5931\uFF1A${projectId}`);
  const targetVersions = db.prepare(
    `SELECT t.id, t.version, t.goal_text, t.published_by, t.published_at, m.name AS published_by_name
         FROM project_target_version t
         LEFT JOIN member m ON m.id = t.published_by
        WHERE t.project_id = ?
        ORDER BY t.version DESC`
  ).all(projectId);
  const currentTarget = targetVersions.find((item) => Number(item.version) === Number(row.current_target_version)) ?? null;
  const metricRows = db.prepare(
    `SELECT m.* FROM project_metric m
        WHERE m.project_id = ? AND m.version_id = ?
        ORDER BY m.name`
  ).all(projectId, currentTarget?.id ?? "");
  const observations = metricRows.length ? db.prepare(
    `SELECT metric_id, value, observed_at, window_start, window_end, source_ref
             FROM metric_observation
            WHERE metric_id IN (${metricRows.map(() => "?").join(",")})
            ORDER BY window_end DESC, observed_at DESC, rowid DESC`
  ).all(...metricRows.map((metric) => metric.id)) : [];
  const byMetric = /* @__PURE__ */ new Map();
  for (const observation of observations) {
    const list = byMetric.get(observation.metric_id) ?? [];
    list.push(observation);
    byMetric.set(observation.metric_id, list);
  }
  const metrics = metricRows.map((metric) => {
    const list = byMetric.get(metric.id) ?? [];
    const latest = list[0] ?? null;
    return {
      id: metric.id,
      name: metric.name,
      direction: metric.direction,
      target_value: metric.target_value === null ? null : Number(metric.target_value),
      target_max: metric.target_max === null ? null : Number(metric.target_max),
      unit: metric.unit,
      definition_text: metric.definition_text,
      calculator_key: metric.calculator_key,
      window_kind: metric.window_kind,
      source_kind: metric.source_kind,
      source_ref: metric.source_ref,
      calculator_params_json: metric.calculator_params_json,
      latest: latest ? {
        value: latest.value === null ? null : Number(latest.value),
        observed_at: Number(latest.observed_at),
        window_start: Number(latest.window_start),
        window_end: Number(latest.window_end),
        source_ref: latest.source_ref
      } : null,
      series: list.slice(0, 12).reverse().map((item) => ({ value: item.value === null ? null : Number(item.value), window_end: Number(item.window_end) }))
    };
  });
  const budgets = db.prepare(
    `SELECT period_kind, period_start, metric, used, limit_value
         FROM project_budget WHERE project_id = ?
        ORDER BY period_start DESC, metric LIMIT 40`
  ).all(projectId);
  const recentItems = db.prepare(
    `SELECT id, title, domain, status, owner_human_id, assignee_id, due_at, updated_at
         FROM work_item WHERE project_id = ?
        ORDER BY updated_at DESC LIMIT 8`
  ).all(projectId);
  return {
    ...summary,
    draft: row.status === "draft" ? readProjectDraft(db, projectId) : null,
    target_versions: targetVersions.map((item) => ({
      ...item,
      version: Number(item.version),
      published_at: Number(item.published_at)
    })),
    current_target: currentTarget ? {
      id: currentTarget.id,
      version: Number(currentTarget.version),
      goal_text: currentTarget.goal_text,
      published_at: Number(currentTarget.published_at)
    } : null,
    metrics,
    budgets: budgets.map((item) => ({
      ...item,
      used: Number(item.used),
      limit_value: Number(item.limit_value)
    })),
    recent_items: recentItems.map((item) => ({
      ...item,
      due_at: item.due_at === null ? null : Number(item.due_at),
      updated_at: Number(item.updated_at)
    }))
  };
}
function insertProject(db, ids, now, actorId, input) {
  const name2 = text(input.name, "\u9879\u76EE\u540D");
  const type = oneOf(input.type, "\u9879\u76EE\u7C7B\u578B", PROJECT_TYPES);
  const publish = input.publish !== false;
  const goalText = text(input.goalText ?? "", "\u76EE\u6807", MAX_GOAL, !publish);
  const ownerHumanId = input.ownerHumanId ?? actorId;
  const coordinatorId = input.coordinatorId === void 0 ? defaultCoordinatorId(db) : input.coordinatorId === null || input.coordinatorId === "" ? null : text(input.coordinatorId, "\u63A8\u8FDB bot", 64);
  const duplicate = db.prepare("SELECT id FROM project WHERE name = ? AND deleted_at IS NULL").get(name2);
  if (duplicate) {
    throw stateInvalid(`\u9879\u76EE\u540D\u5DF2\u5B58\u5728\uFF1A${name2}`, "\u6362\u4E00\u4E2A\u540D\u5B57\uFF0C\u6216\u6253\u5F00\u5DF2\u6709\u9879\u76EE");
  }
  const owner = db.prepare("SELECT id, kind FROM member WHERE id = ?").get(ownerHumanId);
  if (!owner || owner.kind !== "human") throw stateInvalid("\u9879\u76EE\u8D1F\u8D23\u4EBA\u5FC5\u987B\u662F\u5B58\u5728\u7684\u4EBA");
  if (coordinatorId) {
    const coordinator = db.prepare("SELECT id, kind FROM member WHERE id = ?").get(coordinatorId);
    if (!coordinator) throw stateInvalid(`\u63A8\u8FDB\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${coordinatorId}`);
  }
  const metrics = Array.isArray(input.metrics) ? input.metrics : [];
  if (metrics.length > MAX_METRICS) throw stateInvalid(`\u6307\u6807\u6700\u591A ${MAX_METRICS} \u4E2A`);
  const id = ids();
  const status = publish ? "active" : "draft";
  db.prepare(
    `INSERT INTO project
       (id, name, type, status, owner_human_id, coordinator_id, goal_text,
        current_target_version, no_progress_streak, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`
  ).run(id, name2, type, status, ownerHumanId, coordinatorId, goalText, now, now);
  let targetVersionId = null;
  if (publish) {
    targetVersionId = ids();
    db.prepare(
      `INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(targetVersionId, id, goalText, actorId, now);
    db.prepare("UPDATE project SET current_target_version = 1 WHERE id = ?").run(id);
    for (const metric of metrics) insertMetric(db, ids, id, targetVersionId, metric);
  }
  return { id, revision: 1, targetVersionId };
}
function insertMetric(db, ids, projectId, versionId, input) {
  const name2 = text(input.name, "\u6307\u6807\u540D", MAX_METRIC_NAME);
  const direction = oneOf(input.direction, "\u6307\u6807\u65B9\u5411", METRIC_DIRECTIONS);
  const windowKind = oneOf(input.windowKind, "\u7EDF\u8BA1\u7A97\u53E3", METRIC_WINDOWS);
  const targetValue = finiteNumber(input.targetValue, "\u76EE\u6807\u503C");
  const targetMax = finiteNumber(input.targetMax, "\u4E0A\u754C");
  const unit = optionalText(input.unit, "\u5355\u4F4D", 20);
  const definitionText = optionalText(input.definitionText, "\u53E3\u5F84\u8BF4\u660E", 500) ?? "";
  const sourceKind = input.sourceKind ? oneOf(input.sourceKind, "\u6570\u636E\u6765\u6E90", ["ledger", "work_item", "webhook", "manual"]) : "manual";
  if (direction === "range" && (targetValue === null || targetMax === null)) {
    throw stateInvalid("\u533A\u95F4\u6307\u6807\u8981\u540C\u65F6\u7ED9\u4E0B\u754C\u4E0E\u4E0A\u754C");
  }
  if (direction !== "range" && targetValue === null) {
    throw stateInvalid("\u975E\u533A\u95F4\u6307\u6807\u8981\u7ED9\u76EE\u6807\u503C");
  }
  if (direction === "range" && targetMax < targetValue) throw stateInvalid("\u533A\u95F4\u4E0A\u754C\u4E0D\u80FD\u5C0F\u4E8E\u4E0B\u754C");
  const calculatorKey = optionalText(input.calculatorKey, "\u8BA1\u7B97\u65B9\u5F0F", 80);
  if (calculatorKey && !["manual_latest", "work_item_count", "work_item_completion_rate"].includes(calculatorKey)) throw stateInvalid("\u672A\u77E5\u7684\u9884\u7F6E\u8BA1\u7B97\u65B9\u5F0F");
  if (calculatorKey === "manual_latest" && sourceKind !== "manual") throw stateInvalid("manual_latest \u9700\u8981 manual \u6765\u6E90");
  if (calculatorKey?.startsWith("work_item_") && sourceKind !== "work_item") throw stateInvalid("\u5DE5\u4F5C\u9879\u8BA1\u7B97\u5668\u9700\u8981 work_item \u6765\u6E90");
  const params = input.calculatorParams ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some((key) => !["domain", "status"].includes(key)) || Object.values(params).some((value) => typeof value !== "string")) throw stateInvalid("\u8BA1\u7B97\u5668\u53C2\u6570\u4EC5\u652F\u6301 domain / status \u5B57\u7B26\u4E32\u7B5B\u9009");
  const sourceRef = optionalText(input.sourceRef, "\u6570\u636E\u6765\u6E90\u5F15\u7528", 500);
  const id = ids();
  db.prepare(
    `INSERT INTO project_metric
       (id, project_id, version_id, name, direction, target_value, target_max, unit,
        definition_text, calculator_key, calculator_params_json, window_kind, source_kind, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, versionId, name2, direction, targetValue, targetMax, unit, definitionText, calculatorKey, JSON.stringify(params), windowKind, sourceKind, sourceRef);
  return id;
}
function setProjectStatus(db, ids, now, actorId, projectId, to) {
  const project = db.prepare("SELECT * FROM project WHERE id = ?").get(projectId);
  if (!project) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`);
  if (project.deleted_at) throw stateInvalid("\u9879\u76EE\u5DF2\u5220\u9664\uFF0C\u4E0D\u80FD\u518D\u6539\u72B6\u6001");
  const target = oneOf(to, "\u9879\u76EE\u72B6\u6001", PROJECT_STATUSES);
  const before = project.status;
  if (before === target) return { before, after: target, revision: Number(project.revision), targetVersionId: null };
  const allowed = {
    draft: ["active", "archived"],
    active: ["paused", "archived"],
    paused: ["active", "archived"],
    archived: []
  };
  if (!allowed[before]?.includes(target)) {
    throw stateInvalid(`\u9879\u76EE\u72B6\u6001\u4E0D\u80FD\u4ECE ${before} \u6539\u4E3A ${target}`, "\u5F52\u6863\u540E\u53EA\u80FD\u65B0\u5EFA\u9879\u76EE\uFF1B\u8349\u7A3F\u8981\u5148\u53D1\u5E03\u76EE\u6807");
  }
  let targetVersionId = null;
  if (target === "active" && Number(project.current_target_version) === 0) {
    const goal = String(project.goal_text ?? "").trim();
    if (!goal) throw stateInvalid("\u6CA1\u6709\u76EE\u6807\u53E3\u5F84\u7684\u9879\u76EE\u4E0D\u80FD\u8FDB\u5165\u8FDB\u884C\u4E2D", "\u5148\u5199\u76EE\u6807\uFF0C\u518D\u53D1\u5E03");
    targetVersionId = ids();
    db.prepare(
      `INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(targetVersionId, projectId, goal, actorId, now);
    db.prepare("UPDATE project SET current_target_version = 1 WHERE id = ?").run(projectId);
  }
  const revision = Number(project.revision) + 1;
  db.prepare("UPDATE project SET status = ?, revision = ?, updated_at = ? WHERE id = ?").run(target, revision, now, projectId);
  return { before, after: target, revision, targetVersionId };
}
var WINDOW_MS = {
  day: 864e5,
  week: 7 * 864e5,
  month: 30 * 864e5,
  snapshot: 0
};
function recordObservation(db, ids, now, input) {
  const metric = db.prepare(
    `SELECT m.id, m.window_kind, m.project_id FROM project_metric m WHERE m.id = ? AND m.project_id = ?`
  ).get(input.metricId, input.projectId);
  if (!metric) throw stateInvalid(`\u6307\u6807\u4E0D\u5C5E\u4E8E\u8BE5\u9879\u76EE\uFF1A${input.metricId}`);
  const observedAt = input.observedAt === void 0 ? now : finiteNumber(input.observedAt, "\u89C2\u6D4B\u65F6\u95F4");
  if (observedAt === null) throw stateInvalid("\u89C2\u6D4B\u65F6\u95F4\u5FC5\u987B\u7ED9\u503C");
  const value = input.value === void 0 ? null : finiteNumber(input.value, "\u8BFB\u6570");
  const span = WINDOW_MS[metric.window_kind] ?? 0;
  const windowEnd = input.windowEnd === void 0 ? observedAt : finiteNumber(input.windowEnd, "\u7A97\u53E3\u7ED3\u675F");
  if (windowEnd === null) throw stateInvalid("\u7A97\u53E3\u7ED3\u675F\u5FC5\u987B\u7ED9\u503C");
  const windowStart = input.windowStart === void 0 ? metric.window_kind === "snapshot" ? windowEnd : windowEnd - span : finiteNumber(input.windowStart, "\u7A97\u53E3\u5F00\u59CB");
  if (windowStart === null) throw stateInvalid("\u7A97\u53E3\u5F00\u59CB\u5FC5\u987B\u7ED9\u503C");
  if (windowStart > windowEnd) throw stateInvalid("\u7A97\u53E3\u5F00\u59CB\u4E0D\u80FD\u665A\u4E8E\u7ED3\u675F");
  const sourceRef = optionalText(input.sourceRef, "\u6570\u636E\u5F15\u7528", 500);
  const id = ids();
  db.prepare(
    `INSERT INTO metric_observation (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, metric.id, observedAt, windowStart, windowEnd, value, sourceRef, now);
  db.prepare("UPDATE project SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, input.projectId);
  return { id, metricId: metric.id, windowStart, windowEnd, value };
}
var DRAFT_KEY_PREFIX = "project:draft:";
var MAX_DRAFT_STEP = 4;
function draftKey(projectId) {
  return `${DRAFT_KEY_PREFIX}${projectId}`;
}
function sanitizeDraftMetrics(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_METRICS).map((raw) => {
    const metric = raw && typeof raw === "object" ? raw : {};
    const direction = METRIC_DIRECTIONS.includes(String(metric.direction)) ? metric.direction : "higher";
    const windowKind = METRIC_WINDOWS.includes(String(metric.windowKind)) ? metric.windowKind : "week";
    const numberOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      name: String(metric.name ?? "").slice(0, MAX_METRIC_NAME),
      direction,
      targetValue: numberOrNull(metric.targetValue),
      targetMax: numberOrNull(metric.targetMax),
      unit: typeof metric.unit === "string" ? metric.unit.slice(0, 20) : null,
      windowKind,
      definitionText: typeof metric.definitionText === "string" ? metric.definitionText.slice(0, 500) : null,
      sourceKind: typeof metric.sourceKind === "string" && ["ledger", "work_item", "webhook", "manual"].includes(metric.sourceKind) ? metric.sourceKind : "manual",
      calculatorKey: typeof metric.calculatorKey === "string" ? metric.calculatorKey.slice(0, 80) : null,
      calculatorParams: metric.calculatorParams && typeof metric.calculatorParams === "object" && !Array.isArray(metric.calculatorParams) ? metric.calculatorParams : {},
      sourceRef: typeof metric.sourceRef === "string" ? metric.sourceRef.slice(0, 500) : null
    };
  });
}
function readProjectDraft(db, projectId) {
  const row = db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(draftKey(projectId));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      step: Math.min(Math.max(Number(parsed.step) || 0, 0), MAX_DRAFT_STEP),
      metrics: sanitizeDraftMetrics(parsed.metrics),
      savedAt: Number(parsed.savedAt) || 0,
      savedBy: String(parsed.savedBy || "")
    };
  } catch {
    return null;
  }
}
function clearProjectDraft(db, projectId) {
  db.prepare("DELETE FROM hams_meta WHERE key = ?").run(draftKey(projectId));
}
function saveProjectDraft(db, ids, now, actorId, input) {
  const step = Math.min(Math.max(Number(input.step) || 0, 0), MAX_DRAFT_STEP);
  const metrics = sanitizeDraftMetrics(input.metrics);
  let projectId = optionalText(input.projectId, "\u9879\u76EE id", 64);
  let created = false;
  let revision;
  if (!projectId) {
    const inserted = insertProject(db, ids, now, actorId, {
      name: input.name,
      type: input.type,
      goalText: input.goalText ?? "",
      coordinatorId: input.coordinatorId,
      metrics: [],
      publish: false
    });
    projectId = inserted.id;
    revision = inserted.revision;
    created = true;
  } else {
    const row = db.prepare("SELECT * FROM project WHERE id = ?").get(projectId);
    if (!row) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`);
    if (row.deleted_at) throw stateInvalid("\u9879\u76EE\u5DF2\u5220\u9664\uFF0C\u4E0D\u80FD\u518D\u4FDD\u5B58\u8349\u7A3F");
    if (row.status !== "draft") throw stateInvalid("\u53EA\u6709\u8349\u7A3F\u9879\u76EE\u80FD\u5728\u65B0\u5EFA\u5411\u5BFC\u91CC\u7EE7\u7EED\u4FEE\u6539", "\u5DF2\u53D1\u5E03\u9879\u76EE\u8BF7\u53D1\u5E03\u65B0\u76EE\u6807\u7248\u672C");
    const name2 = text(input.name, "\u9879\u76EE\u540D");
    const type = oneOf(input.type, "\u9879\u76EE\u7C7B\u578B", PROJECT_TYPES);
    const goalText = text(input.goalText ?? "", "\u76EE\u6807", MAX_GOAL, true);
    const coordinatorId = input.coordinatorId === void 0 ? row.coordinator_id : input.coordinatorId === null || input.coordinatorId === "" ? null : text(input.coordinatorId, "\u63A8\u8FDB bot", 64);
    if (coordinatorId) {
      const coordinator = db.prepare("SELECT id FROM member WHERE id = ?").get(coordinatorId);
      if (!coordinator) throw stateInvalid(`\u63A8\u8FDB\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${coordinatorId}`);
    }
    const duplicate = db.prepare("SELECT id FROM project WHERE name = ? AND id <> ? AND deleted_at IS NULL").get(name2, projectId);
    if (duplicate) throw stateInvalid(`\u9879\u76EE\u540D\u5DF2\u5B58\u5728\uFF1A${name2}`, "\u6362\u4E00\u4E2A\u540D\u5B57\uFF0C\u6216\u6253\u5F00\u5DF2\u6709\u9879\u76EE");
    revision = Number(row.revision) + 1;
    db.prepare(
      "UPDATE project SET name = ?, type = ?, goal_text = ?, coordinator_id = ?, revision = ?, updated_at = ? WHERE id = ?"
    ).run(name2, type, goalText, coordinatorId, revision, now, projectId);
  }
  const state = { step, metrics, savedAt: now, savedBy: actorId };
  db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(draftKey(projectId), JSON.stringify(state));
  return { projectId, revision, created, savedAt: now, step };
}
function softDeleteProject(db, now, actorId, projectId) {
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get(projectId);
  if (!row) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`);
  if (row.deleted_at) throw stateInvalid("\u9879\u76EE\u5DF2\u7ECF\u5220\u9664");
  if (row.status !== "archived") throw stateInvalid("\u53EA\u6709\u5DF2\u5F52\u6863\u7684\u9879\u76EE\u53EF\u4EE5\u5220\u9664", "\u5148\u5F52\u6863\u9879\u76EE\uFF0C\u518D\u5220\u9664");
  const detached = db.prepare("UPDATE work_item SET project_id = NULL, revision = revision + 1 WHERE project_id = ?").run(projectId);
  const revision = Number(row.revision) + 1;
  const tombstone = `${row.name}\xB7\u5DF2\u5220\u9664\xB7${projectId.slice(-6)}`;
  db.prepare(
    "UPDATE project SET deleted_at = ?, deleted_by = ?, deleted_name = ?, name = ?, revision = ?, updated_at = ? WHERE id = ?"
  ).run(now, actorId, row.name, tombstone, revision, now, projectId);
  clearProjectDraft(db, projectId);
  return { id: projectId, revision, detachedWorkItems: Number(detached.changes ?? 0) };
}

// src/service/project-lifecycle.ts
function projectRow(db, id) {
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id);
  if (!row || row.deleted_at) throw stateInvalid("\u9879\u76EE\u4E0D\u5B58\u5728");
  return row;
}
function human(db, id) {
  const row = db.prepare("SELECT kind, status FROM member WHERE id = ?").get(id);
  if (!row || row.kind !== "human" || row.status !== "active") throw stateInvalid("\u786E\u8BA4\u4EBA\u4E0E\u9A8C\u6536\u4EBA\u5FC5\u987B\u662F\u5728\u7528\u7684\u4EBA\u7C7B\u6210\u5458");
  return id;
}
function text2(value, label, max = 4e3) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw stateInvalid(`${label}\u4E0D\u80FD\u4E3A\u7A7A\u4E14\u6700\u591A${max}\u5B57`);
  return value.trim();
}
function time(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw stateInvalid("\u65F6\u95F4\u5FC5\u987B\u662F\u6574\u6570\u6BEB\u79D2");
  return value;
}
function publishTarget(db, ids, now, actor, input) {
  const p = projectRow(db, input.projectId);
  if (p.status === "archived") throw stateInvalid("\u5F52\u6863\u9879\u76EE\u4E0D\u80FD\u53D1\u5E03\u76EE\u6807");
  const goal = text2(input.goalText, "\u76EE\u6807");
  if (!Array.isArray(input.metrics ?? []) || (input.metrics?.length ?? 0) > 12) throw stateInvalid("\u6307\u6807\u5FC5\u987B\u662F\u6700\u591A12\u9879\u7684\u6570\u7EC4");
  const id = ids(), version = p.current_target_version + 1;
  db.prepare("INSERT INTO project_target_version (id,project_id,version,goal_text,published_by,published_at) VALUES (?,?,?,?,?,?)").run(id, p.id, version, goal, actor, now);
  const metrics = input.metrics ?? db.prepare("SELECT * FROM project_metric WHERE project_id=? AND version_id=(SELECT id FROM project_target_version WHERE project_id=? AND version=?)").all(p.id, p.id, p.current_target_version).map((m) => ({ name: m.name, direction: m.direction, targetValue: m.target_value, targetMax: m.target_max, unit: m.unit, windowKind: m.window_kind, definitionText: m.definition_text, sourceKind: m.source_kind, sourceRef: m.source_ref, calculatorKey: m.calculator_key, calculatorParams: JSON.parse(m.calculator_params_json) }));
  for (const metric of metrics) insertMetric(db, ids, p.id, id, metric);
  db.prepare("UPDATE project SET goal_text=?,current_target_version=?,status=CASE WHEN status='draft' THEN 'active' ELSE status END WHERE id=?").run(goal, version, p.id);
  return { targetVersionId: id, version };
}
function ensureDefaultPlan(db, ids, now, projectId) {
  const project = projectRow(db, projectId);
  const phases = db.prepare("SELECT id FROM project_phase WHERE project_id=? ORDER BY seq").all(projectId);
  if (phases.length) return { phaseId: String(phases[0].id), created: false };
  const phaseId = ids();
  db.prepare("INSERT INTO project_phase (id,project_id,seq,name,starts_at,ends_at,status) VALUES (?,?,1,?,?,?, 'active')").run(phaseId, projectId, "\u9ED8\u8BA4\u9636\u6BB5", now, 253402300799e3);
  db.prepare("INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id,detail) VALUES (?,?,NULL,?,NULL,?,?)").run(ids(), phaseId, "\u9996\u4E2A\u76EE\u6807", project.owner_human_id, "\u5199\u6E05\u8FD9\u4E2A\u76EE\u6807\u600E\u4E48\u7B97\u3001\u600E\u4E48\u9A8C\u6536\uFF1B\u4E4B\u540E\u53EF\u4EE5\u6539\u6210\u771F\u6B63\u7684\u9636\u6BB5\u76EE\u6807\u3002");
  return { phaseId, created: true };
}
function ensureAllDefaultPlans(db, ids, now) {
  const projects = db.prepare("SELECT id FROM project WHERE status IN ('active','paused')").all();
  let created = 0;
  for (const project of projects) if (ensureDefaultPlan(db, ids, now, String(project.id)).created) created += 1;
  return { created };
}
function addPhaseTarget(db, ids, input) {
  const project = projectRow(db, input.projectId);
  const phase2 = db.prepare("SELECT * FROM project_phase WHERE id=? AND project_id=?").get(input.phaseId, input.projectId);
  if (!phase2) throw stateInvalid("\u9636\u6BB5\u4E0D\u5C5E\u4E8E\u8BE5\u9879\u76EE");
  if (["confirmed", "done"].includes(String(phase2.status))) throw stateInvalid("\u5DF2\u786E\u8BA4\u7684\u9636\u6BB5\u4E0D\u80FD\u518D\u52A0\u76EE\u6807");
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM project_phase_target WHERE phase_id=?").get(input.phaseId).n);
  if (count >= 30) throw stateInvalid("\u4E00\u4E2A\u9636\u6BB5\u6700\u591A 30 \u4E2A\u76EE\u6807");
  if (input.metricId) {
    if (!db.prepare("SELECT id FROM project_metric WHERE id=? AND project_id=?").get(input.metricId, input.projectId)) throw stateInvalid("\u76EE\u6807\u6307\u6807\u5FC5\u987B\u5C5E\u4E8E\u672C\u9879\u76EE");
  }
  const targetValue = input.targetValue ?? null;
  if (targetValue !== null && (typeof targetValue !== "number" || !Number.isFinite(targetValue))) throw stateInvalid("\u76EE\u6807\u503C\u5FC5\u987B\u4E3A\u6709\u9650\u6570\u5B57");
  const verifier = human(db, input.verifierHumanId ?? project.owner_human_id);
  const id = ids();
  db.prepare("INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id,detail) VALUES (?,?,?,?,?,?,?)").run(id, input.phaseId, input.metricId ?? null, text2(input.description, "\u76EE\u6807\u63CF\u8FF0"), targetValue, verifier, (input.detail ?? "").slice(0, 2e3));
  return { targetId: id };
}
function createPhase(db, ids, actor, input) {
  const p = projectRow(db, input.projectId);
  const start = time(input.startsAt), end = time(input.endsAt);
  if (end < start) throw stateInvalid("\u9636\u6BB5\u7ED3\u675F\u4E0D\u80FD\u65E9\u4E8E\u5F00\u59CB");
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 30) throw stateInvalid("\u9636\u6BB5\u9700\u89811\u81F330\u9879\u9A8C\u6536\u76EE\u6807");
  if (input.checks !== void 0 && (!Array.isArray(input.checks) || input.checks.length > 50)) throw stateInvalid("\u68C0\u67E5\u9879\u6700\u591A50\u9879");
  const id = ids(), seq = Number(db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM project_phase WHERE project_id=?").get(p.id).n);
  db.prepare("INSERT INTO project_phase (id,project_id,seq,name,starts_at,ends_at,confirmer_id) VALUES (?,?,?,?,?,?,?)").run(id, p.id, seq, text2(input.name, "\u9636\u6BB5\u540D\u79F0", 100), start, end, human(db, input.confirmerId ?? p.owner_human_id));
  for (const t of input.targets) {
    if (t.metricId && !db.prepare("SELECT id FROM project_metric WHERE id=? AND project_id=?").get(t.metricId, p.id)) throw stateInvalid("\u9636\u6BB5\u6307\u6807\u5FC5\u987B\u5C5E\u4E8E\u672C\u9879\u76EE");
    if (t.targetValue !== void 0 && (typeof t.targetValue !== "number" || !Number.isFinite(t.targetValue))) throw stateInvalid("\u76EE\u6807\u503C\u5FC5\u987B\u4E3A\u6709\u9650\u6570\u5B57");
    db.prepare("INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id) VALUES (?,?,?,?,?,?)").run(ids(), id, t.metricId ?? null, text2(t.description, "\u76EE\u6807\u63CF\u8FF0"), t.targetValue ?? null, human(db, t.verifierHumanId));
  }
  for (const label of input.checks ?? []) db.prepare("INSERT INTO project_phase_check (id,phase_id,label) VALUES (?,?,?)").run(ids(), id, text2(label, "\u68C0\u67E5\u9879", 200));
  return { phaseId: id };
}
function phase(db, input) {
  const row = db.prepare("SELECT * FROM project_phase WHERE id=? AND project_id=?").get(input.phaseId, input.projectId);
  if (!row) throw stateInvalid("\u9636\u6BB5\u4E0D\u5C5E\u4E8E\u8BE5\u9879\u76EE");
  if (row.status === "done") throw stateInvalid("\u5DF2\u786E\u8BA4\u9636\u6BB5\u4E0D\u53EF\u4FEE\u6539");
  return row;
}
function updatePhase(db, now, actor, input) {
  const row = phase(db, input);
  if (input.status !== void 0) {
    const allowed = { planned: ["active"], active: ["awaiting_confirm"], awaiting_confirm: ["active"] };
    if (!allowed[row.status]?.includes(input.status)) throw stateInvalid("\u975E\u6CD5\u9636\u6BB5\u72B6\u6001\u8F6C\u6362\uFF1B\u65E5\u671F\u4E0D\u81EA\u52A8\u5B8C\u6210\u9636\u6BB5");
    db.prepare("UPDATE project_phase SET status=? WHERE id=?").run(input.status, row.id);
  }
  if (input.checkId !== void 0) {
    if (typeof input.checked !== "boolean") throw stateInvalid("\u52FE\u9009\u72B6\u6001\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C");
    const result = db.prepare("UPDATE project_phase_check SET checked=?,checked_by=?,checked_at=? WHERE id=? AND phase_id=?").run(input.checked ? 1 : 0, actor, now, input.checkId, row.id);
    if (!result.changes) throw stateInvalid("\u68C0\u67E5\u9879\u4E0D\u5C5E\u4E8E\u672C\u9636\u6BB5");
  }
  if (input.status === void 0 && input.checkId === void 0) throw stateInvalid("\u6CA1\u6709\u9636\u6BB5\u4FEE\u6539\u5185\u5BB9");
  return { phaseId: row.id };
}
function confirmPhase(db, now, actor, input) {
  const row = phase(db, input);
  if (row.status !== "awaiting_confirm") throw stateInvalid("\u9636\u6BB5\u9700\u5148\u63D0\u4EA4\u4EBA\u5DE5\u786E\u8BA4");
  if (row.confirmer_id !== actor) throw denied("\u53EA\u6709\u6307\u5B9A\u786E\u8BA4\u4EBA\u80FD\u786E\u8BA4\u9636\u6BB5");
  db.prepare("UPDATE project_phase SET status='done',confirmed_by=?,confirmed_at=? WHERE id=?").run(actor, now, row.id);
  return { phaseId: row.id };
}
function tryMetric(db, now, projectId, metric, period, metricId) {
  const end = period?.end ?? now, start = period?.start ?? end - ({ day: 1, week: 7, month: 30, snapshot: 0 }[metric.windowKind] ?? 0) * 864e5;
  let value = null, evidenceRef = null, reason;
  if (!projectId) reason = "\u5148\u521B\u5EFA\u9879\u76EE\u540E\u8BD5\u7B97";
  else if (!metric.calculatorKey || !metric.sourceKind) reason = "\u7F3A\u5C11\u8BA1\u7B97\u53E3\u5F84\u6216\u6570\u636E\u6765\u6E90";
  else if (metric.calculatorKey === "manual_latest" && metric.sourceKind === "manual") {
    if (!metric.sourceRef) reason = "\u4EBA\u5DE5\u8BFB\u6570\u9700\u8981\u660E\u786E\u6570\u636E\u6765\u6E90\u5F15\u7528";
    else if (metricId) {
      const row = db.prepare("SELECT value,source_ref FROM metric_observation WHERE metric_id=? AND observed_at<=? AND window_end<=? AND window_end>=? AND source_ref=? ORDER BY window_end DESC,observed_at DESC,rowid DESC LIMIT 1").get(metricId, end, end, start, metric.sourceRef);
      value = row?.value ?? null;
      evidenceRef = row?.source_ref ?? null;
    } else reason = "\u5C1A\u65E0\u5DF2\u53D1\u5E03\u6307\u6807\u8BFB\u6570";
  } else if (["work_item_count", "work_item_completion_rate"].includes(metric.calculatorKey) && metric.sourceKind === "work_item") {
    const params = metric.calculatorParams ?? {}, clauses = ["project_id=?", "created_at<=?"], args = [projectId, end];
    if (metric.windowKind !== "snapshot") {
      clauses.push("created_at>=?");
      args.push(start);
    }
    for (const key of ["domain", "status"]) if (params[key]) {
      clauses.push(`${key}=?`);
      args.push(params[key]);
    }
    const rows = db.prepare(`SELECT completed_at FROM work_item WHERE ${clauses.join(" AND ")}`).all(...args);
    value = metric.calculatorKey === "work_item_count" ? rows.length : rows.length ? 100 * rows.filter((r) => r.completed_at !== null && r.completed_at <= end).length / rows.length : null;
    evidenceRef = `hams:project:${projectId}:work_items:${start}:${end}`;
  } else reason = "\u672A\u77E5\u6216\u4E0D\u5339\u914D\u7684\u8BA1\u7B97\u65B9\u5F0F\u4E0E\u6570\u636E\u6765\u6E90";
  if (value === null) reason ??= "\u5F53\u671F\u7F3A\u5C11\u53EF\u7528\u6570\u636E";
  let verdict = "unknown";
  if (value !== null && metric.targetValue !== null && metric.targetValue !== void 0) {
    const met = metric.direction === "higher" ? value >= metric.targetValue : metric.direction === "lower" ? value <= metric.targetValue : metric.targetMax !== null && metric.targetMax !== void 0 && value >= metric.targetValue && value <= metric.targetMax;
    verdict = met ? "met" : "missed";
  }
  return { value, verdict, complete: value !== null && !reason, reason, windowStart: start, windowEnd: end, evidenceRef };
}
function createReview(db, ids, now, actor, input) {
  const p = projectRow(db, input.projectId), start = time(input.periodStart), end = time(input.periodEnd);
  if (!["weekly", "monthly", "quarterly", "phase"].includes(input.kind) || start > end || end > now) throw stateInvalid("\u590D\u76D8\u7C7B\u578B\u6216\u5468\u671F\u4E0D\u5408\u6CD5\uFF08\u4E0D\u80FD\u51BB\u7ED3\u672A\u6765\uFF09");
  const target = db.prepare("SELECT id FROM project_target_version WHERE project_id=? AND published_at<=? ORDER BY version DESC LIMIT 1").get(p.id, end);
  if (!target) throw stateInvalid("\u9700\u8981\u5148\u53D1\u5E03\u9879\u76EE\u76EE\u6807");
  const id = ids();
  db.prepare("INSERT INTO project_review (id,project_id,kind,period_start,period_end,target_version_id,status,conclusion_text,confirmer_id) VALUES (?,?,?,?,?,?,'awaiting_confirm',?,?)").run(id, p.id, input.kind, start, end, target.id, input.conclusionText ? text2(input.conclusionText, "\u7ED3\u8BBA") : null, human(db, input.confirmerId ?? p.owner_human_id));
  const metrics = db.prepare("SELECT * FROM project_metric WHERE version_id=?").all(target.id);
  for (const m of metrics) {
    const trial = tryMetric(db, now, p.id, { name: m.name, direction: m.direction, targetValue: m.target_value, targetMax: m.target_max, windowKind: m.window_kind, sourceKind: m.source_kind, sourceRef: m.source_ref, calculatorKey: m.calculator_key, calculatorParams: JSON.parse(m.calculator_params_json) }, { start, end }, m.id);
    db.prepare("INSERT INTO project_review_metric (review_id,metric_id,target_value,actual_value,verdict,evidence_ref) VALUES (?,?,?,?,?,?)").run(id, m.id, m.target_value, trial.value, trial.verdict, trial.evidenceRef);
  }
  return { reviewId: id, targetVersionId: target.id };
}
function confirmReview(db, now, actor, input) {
  const row = db.prepare("SELECT * FROM project_review WHERE id=? AND project_id=?").get(input.reviewId, input.projectId);
  if (!row || row.status !== "awaiting_confirm") throw stateInvalid("\u590D\u76D8\u4E0D\u5B58\u5728\u6216\u5DF2\u786E\u8BA4");
  if (row.confirmer_id !== actor) throw denied("\u53EA\u6709\u6307\u5B9A\u786E\u8BA4\u4EBA\u80FD\u786E\u8BA4\u590D\u76D8");
  db.prepare("UPDATE project_review SET status='confirmed',confirmed_by=?,confirmed_at=? WHERE id=?").run(actor, now, row.id);
  return { reviewId: row.id };
}
function updatePhaseTarget(db, input) {
  const target = db.prepare("SELECT t.*, p.status AS phase_status FROM project_phase_target t JOIN project_phase p ON p.id=t.phase_id WHERE t.id=? AND p.project_id=?").get(input.targetId, input.projectId);
  if (!target) throw stateInvalid("\u76EE\u6807\u4E0D\u5C5E\u4E8E\u8BE5\u9879\u76EE");
  if (["confirmed", "done"].includes(String(target.phase_status))) throw stateInvalid("\u5DF2\u786E\u8BA4\u7684\u9636\u6BB5\u4E0D\u80FD\u518D\u6539\u76EE\u6807");
  const description = input.description === void 0 ? target.description : text2(input.description, "\u76EE\u6807\u63CF\u8FF0");
  let targetValue = target.target_value;
  if (input.targetValue !== void 0) {
    if (input.targetValue === null) targetValue = null;
    else if (typeof input.targetValue !== "number" || !Number.isFinite(input.targetValue)) throw stateInvalid("\u76EE\u6807\u503C\u5FC5\u987B\u4E3A\u6709\u9650\u6570\u5B57");
    else targetValue = input.targetValue;
  }
  const verifier = input.verifierHumanId === void 0 ? target.verifier_human_id : human(db, input.verifierHumanId);
  const detail = input.detail === void 0 ? target.detail : (input.detail || "").slice(0, 2e3);
  db.prepare("UPDATE project_phase_target SET description=?,detail=?,target_value=?,verifier_human_id=? WHERE id=?").run(description, detail, targetValue, verifier, target.id);
  return { targetId: target.id };
}
function submitTargetCheck(db, ids, now, actor, input) {
  const target = db.prepare("SELECT t.id,p.status AS phase_status FROM project_phase_target t JOIN project_phase p ON p.id=t.phase_id WHERE t.id=? AND p.project_id=?").get(input.targetId, input.projectId);
  if (!target) throw stateInvalid("\u76EE\u6807\u4E0D\u5C5E\u4E8E\u8BE5\u9879\u76EE");
  const url = (input.reportUrl ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) throw stateInvalid("\u62A5\u544A\u94FE\u63A5\u5FC5\u987B\u662F http(s) \u5730\u5740");
  if (url.length > 500) throw stateInvalid("\u62A5\u544A\u94FE\u63A5\u6700\u591A 500 \u5B57");
  const note = (input.note ?? "").trim();
  if (note.length > 1e3) throw stateInvalid("\u8BF4\u660E\u6700\u591A 1000 \u5B57");
  const summary = text2(input.summary, "\u9A8C\u8BC1\u6458\u8981", 1e3);
  const approver = human(db, input.approverId);
  if (approver === actor) throw stateInvalid("\u63D0\u4EA4\u4EBA\u4E0D\u80FD\u81EA\u5DF1\u5BA1\u6279\uFF0C\u8BF7\u6307\u5B9A\u53E6\u4E00\u4F4D\u5BA1\u6279\u4EBA");
  const checkId = ids();
  db.prepare("INSERT INTO project_phase_target_check (id,project_id,target_id,submitted_by,submitted_at,result,report_url,note,approver_id,summary,status) VALUES (?,?,?,?,?, 'unknown',?,?,?,?, 'pending')").run(checkId, input.projectId, input.targetId, actor, now, url || null, note, approver, summary);
  const approvalId = ids();
  db.prepare(`INSERT INTO approval (id, subject_kind, subject_id, subject_revision, execution_epoch, evidence_set_hash, criteria_ref, criteria_json, reason_text, requested_by, requested_channel, approver_id, status, decision_note, expires_at, created_at)
              VALUES (?, 'target_change', ?, 0, 0, '', '', '{}', ?, ?, 'ui', ?, 'pending', '', ?, ?)`).run(approvalId, checkId, summary, actor, approver, now + 72 * 36e5, now);
  return { checkId, approvalId };
}
function projectLifecycleDetail(db, projectId) {
  const phases = db.prepare("SELECT * FROM project_phase WHERE project_id=? ORDER BY seq").all(projectId).map((p) => ({
    ...p,
    targets: db.prepare("SELECT * FROM project_phase_target WHERE phase_id=? ORDER BY rowid").all(p.id).map((t) => {
      const checks = db.prepare("SELECT c.*,m.name AS submitted_by_name,a.name AS approver_name,d.name AS decided_by_name,ap.id AS approval_id,ap.expires_at AS approval_expires_at FROM project_phase_target_check c LEFT JOIN member m ON m.id=c.submitted_by LEFT JOIN member a ON a.id=c.approver_id LEFT JOIN member d ON d.id=c.decided_by LEFT JOIN approval ap ON ap.subject_kind='target_change' AND ap.subject_id=c.id WHERE c.target_id=? ORDER BY c.submitted_at DESC, c.rowid DESC LIMIT 20").all(t.id);
      return { ...t, checks, achieved: checks.some((c) => c.status === "approved"), pending: checks.some((c) => c.status === "pending"), rejected: checks.length > 0 && !checks.some((c) => c.status === "approved") && !checks.some((c) => c.status === "pending") };
    }),
    checks: db.prepare("SELECT * FROM project_phase_check WHERE phase_id=? ORDER BY rowid").all(p.id)
  }));
  const reviews = db.prepare("SELECT * FROM project_review WHERE project_id=? ORDER BY period_end DESC").all(projectId).map((r) => ({ ...r, metrics: db.prepare("SELECT rm.*,m.name,m.direction,m.target_max,m.unit,m.window_kind,m.calculator_key,m.calculator_params_json,m.definition_text FROM project_review_metric rm JOIN project_metric m ON m.id=rm.metric_id WHERE review_id=?").all(r.id) }));
  const proposals = db.prepare("SELECT * FROM proposal WHERE project_id=? ORDER BY created_at DESC").all(projectId);
  const decisions = db.prepare("SELECT d.* FROM decision d JOIN proposal p ON p.id=d.proposal_id WHERE p.project_id=? ORDER BY d.created_at DESC").all(projectId);
  const projectEvents = db.prepare("SELECT * FROM audit_log WHERE subject_kind='project' AND subject_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200").all(projectId);
  const workEvents = db.prepare("SELECT e.*,w.title FROM work_item_event e JOIN work_item w ON w.id=e.work_item_id WHERE w.project_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 200").all(projectId);
  const events = [...projectEvents.map((e) => ({ ...e, source_kind: "audit_log" })), ...workEvents.map((e) => ({ ...e, source_kind: "work_item_event", action: e.kind, subject_kind: "work_item", subject_id: e.work_item_id, after_json: e.payload_json }))].sort((a, b) => b.created_at - a.created_at).slice(0, 200);
  return { phases, reviews, progress_records: { proposals, decisions, events } };
}

// src/service/member-config.ts
import { createHash as createHash3 } from "node:crypto";
function publishConfig(db, ids, now, actor, input) {
  const member = db.prepare("SELECT * FROM member WHERE id=?").get(input.memberId);
  if (!member || member.kind !== "bot" || member.status === "retired") throw stateInvalid("\u53EA\u80FD\u4E3A\u672A\u9000\u4F11bot\u53D1\u5E03\u914D\u7F6E");
  if (!["minor", "major"].includes(input.changeClass)) throw stateInvalid("\u53D8\u66F4\u7EA7\u522B\u5FC5\u987B\u4E3Aminor\u6216major");
  const previous = db.prepare("SELECT * FROM member_version WHERE member_id=? AND version=?").get(member.id, member.current_version);
  const string = (value, max) => {
    if (value === null) return null;
    if (typeof value !== "string" || value.length > max) throw stateInvalid("\u914D\u7F6E\u6587\u672C\u7C7B\u578B\u6216\u957F\u5EA6\u4E0D\u5408\u6CD5");
    return value.trim() || null;
  };
  const model = input.model === void 0 ? previous?.model ?? null : string(input.model, 120);
  const agentPreset = input.agentPreset === void 0 ? previous?.agent_preset ?? null : string(input.agentPreset, 80);
  const responsibility = input.responsibility === void 0 ? member.responsibility : string(input.responsibility, 4e3) ?? "";
  if (input.memoryScope !== void 0 && (!input.memoryScope || typeof input.memoryScope !== "object" || Array.isArray(input.memoryScope) || JSON.stringify(input.memoryScope).length > 8e3)) throw stateInvalid("\u8BB0\u5FC6\u8303\u56F4\u5FC5\u987B\u4E3AJSON\u5BF9\u8C61\u4E14\u4E0D\u8D85\u8FC78000\u5B57");
  const memory = input.memoryScope === void 0 ? previous?.memory_scope_json ?? "{}" : JSON.stringify(input.memoryScope);
  const rawPrompt = input.prompt === void 0 ? previous?.prompt ?? "" : String(input.prompt ?? "").trim();
  if (rawPrompt.length > 8192) throw stateInvalid("\u63D0\u793A\u8BCD\u6700\u591A 8192 \u5B57");
  if (input.changeClass === "minor" && (model !== (previous?.model ?? null) || agentPreset !== (previous?.agent_preset ?? null) || memory !== (previous?.memory_scope_json ?? "{}") || rawPrompt !== (previous?.prompt ?? ""))) throw stateInvalid("\u6A21\u578B\u3001preset\u3001\u8BB0\u5FC6\u8303\u56F4\u6216\u63D0\u793A\u8BCD\u53D8\u5316\u9700\u663E\u5F0F\u9009\u62E9\u5927\u6539");
  const version = member.current_version + 1, id = ids(), digest = createHash3("sha256").update(JSON.stringify({ responsibility, model, agentPreset, memory, prompt: rawPrompt })).digest("hex");
  db.prepare("INSERT INTO member_version (id,member_id,version,agent_preset,model,memory_scope_json,prompt,prompt_digest,change_class,published_by,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, member.id, version, agentPreset, model, memory, rawPrompt, digest, input.changeClass, actor, now);
  if (previous) db.prepare("INSERT INTO member_version_skill (member_version_id,skill_id,skill_version_id) SELECT ?,skill_id,skill_version_id FROM member_version_skill WHERE member_version_id=?").run(id, previous.id);
  db.prepare("UPDATE member SET current_version=?,responsibility=?,updated_at=? WHERE id=?").run(version, responsibility, now, member.id);
  return { version, versionId: id, changeClass: input.changeClass, responsibility, model, agentPreset, memoryScope: JSON.parse(memory), prompt: rawPrompt };
}
function memberActivity(db, now, memberId, timeZone = "Asia/Shanghai") {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = format.format(now), keys = [];
  const noon = Date.parse(today + "T12:00:00Z");
  for (let i = 83; i >= 0; i--) keys.push(new Date(noon - i * 864e5).toISOString().slice(0, 10));
  const buckets = new Map(keys.map((day) => [day, { day, count: 0, runs: 0, succeeded: 0, failed: 0 }]));
  const runs = db.prepare("SELECT created_at,status FROM task_run WHERE member_id=? AND created_at>=? AND created_at<=?").all(memberId, now - 85 * 864e5, now);
  for (const run of runs) {
    const b = buckets.get(format.format(run.created_at));
    if (!b) continue;
    b.runs++;
    b.count++;
    if (run.status === "succeeded") b.succeeded++;
    if (run.status === "failed") b.failed++;
  }
  const events = db.prepare("SELECT created_at FROM audit_log WHERE actor_id=? AND created_at>=? AND created_at<=?").all(memberId, now - 85 * 864e5, now);
  for (const event of events) {
    const b = buckets.get(format.format(event.created_at));
    if (b) b.count++;
  }
  const days = [...buckets.values()];
  return { days, total: days.reduce((n, d) => n + d.count, 0), from: keys[0], to: keys[83], timeZone, definition: "count = task_run creations + audit actions; runs counts execution attempts" };
}

// src/service/hams.ts
import { createHash as createHash9 } from "node:crypto";

// src/domain/ids.ts
var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidAt(nowMs, random = Math.random) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error(`\u975E\u6CD5\u65F6\u95F4\u6233\uFF1A${nowMs}`);
  let timePart = "";
  let rest = Math.floor(nowMs);
  for (let i = 0; i < 10; i += 1) {
    timePart = ENCODING[rest % 32] + timePart;
    rest = Math.floor(rest / 32);
  }
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart += ENCODING[Math.floor(random() * 32)];
  }
  return timePart + randomPart;
}
function createIdFactory(now, random = Math.random) {
  return () => ulidAt(now(), random);
}

// src/domain/evidence.ts
import { createHash as createHash4 } from "node:crypto";
function evidenceSetHash(rows) {
  const active = rows.filter((row) => row.status === "active").map((row) => `${row.id}:${row.kind}:${row.contentHash}:${row.observedAt}`).sort();
  return createHash4("sha256").update(active.join("\n")).digest("hex");
}
function toRequirement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = raw;
  const kind = typeof item.kind === "string" ? item.kind.trim() : "";
  if (!kind) return null;
  const minCountRaw = item.min_count ?? item.minCount ?? 1;
  const maxAgeRaw = item.max_age_hours ?? item.maxAgeHours ?? null;
  const minCount = Number(minCountRaw);
  const maxAgeHours = maxAgeRaw === null || maxAgeRaw === void 0 ? null : Number(maxAgeRaw);
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw new Error(`required_evidence \u7684 min_count \u5FC5\u987B\u662F \u22651 \u7684\u6574\u6570\uFF1A${JSON.stringify(raw)}`);
  }
  if (maxAgeHours !== null && (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)) {
    throw new Error(`required_evidence \u7684 max_age_hours \u5FC5\u987B\u662F\u6B63\u6570\uFF1A${JSON.stringify(raw)}`);
  }
  return { kind, minCount, maxAgeHours };
}
function parseEvidenceRequirements(json2) {
  if (!json2 || !json2.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(json2);
  } catch {
    throw new Error(`required_evidence_json \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${json2}`);
  }
  if (!Array.isArray(parsed)) throw new Error("required_evidence_json \u5FC5\u987B\u662F\u6570\u7EC4");
  return parsed.map(toRequirement).filter((item) => item !== null);
}
function evaluateRequirements(rows, requirements, nowMs) {
  const active = rows.filter((row) => row.status === "active");
  const missing = [];
  let used = 0;
  for (const requirement of requirements) {
    const ofKind = active.filter((row) => row.kind === requirement.kind);
    const fresh = requirement.maxAgeHours === null ? ofKind : ofKind.filter((row) => nowMs - row.observedAt <= requirement.maxAgeHours * 36e5);
    if (fresh.length >= requirement.minCount) {
      used += requirement.minCount;
      continue;
    }
    missing.push({
      kind: requirement.kind,
      need: requirement.minCount,
      have: fresh.length,
      reason: fresh.length < ofKind.length ? "stale" : "count"
    });
  }
  return { satisfied: missing.length === 0, missing, used, totalActive: active.length };
}
function buildCriteriaSnapshot(templateVersionId, requirements, rows, nowMs) {
  return {
    templateVersionId,
    requirements,
    result: evaluateRequirements(rows, requirements, nowMs),
    evidenceSetHash: evidenceSetHash(rows)
  };
}

// src/domain/check.ts
var DEFAULT_TZ = "Asia/Shanghai";
function parseClock(time2) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time2.trim());
  if (!match) throw stateInvalid(`\u65F6\u95F4\u683C\u5F0F\u5FC5\u987B\u662F HH:mm\uFF0C\u6536\u5230 ${time2}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
function zoneParts(ms, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date(ms));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second")
  };
}
function offsetAt(ms, timeZone) {
  const parts = zoneParts(ms, timeZone);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(ms / 1e3) * 1e3;
}
function wallToUtc(timeZone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = guess - offsetAt(guess, timeZone);
  const local = zoneParts(candidate, timeZone);
  if (local.hour !== hour || local.minute !== minute) {
    candidate = guess - offsetAt(candidate, timeZone);
  }
  return candidate;
}
function normalizeDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
function parseCheckPolicy(json2) {
  const fallback = {
    mode: "after_hours",
    time: "09:00",
    tz: DEFAULT_TZ,
    hours: 24,
    maxRechecks: null
  };
  if (!json2 || !json2.trim()) return fallback;
  let raw;
  try {
    raw = JSON.parse(json2);
  } catch {
    throw stateInvalid(`check_policy_json \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${json2}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const item = raw;
  const mode = typeof item.mode === "string" ? item.mode : fallback.mode;
  if (!["next_day_at", "after_hours", "next_working_day"].includes(mode)) {
    throw stateInvalid(`\u672A\u77E5\u7684\u590D\u67E5\u8282\u594F\uFF1A${String(item.mode)}`);
  }
  const tz = typeof item.tz === "string" && item.tz.trim() ? item.tz.trim() : DEFAULT_TZ;
  const time2 = typeof item.time === "string" && item.time.trim() ? item.time.trim() : fallback.time;
  parseClock(time2);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw stateInvalid(`\u672A\u77E5\u65F6\u533A\uFF1A${tz}`);
  }
  const hours = item.hours === void 0 ? fallback.hours : Number(item.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw stateInvalid(`\u590D\u67E5\u95F4\u9694\u5C0F\u65F6\u6570\u5FC5\u987B\u662F\u6B63\u6570\uFF1A${String(item.hours)}`);
  const maxRaw = item.max_rechecks ?? item.maxRechecks;
  const maxRechecks = maxRaw === void 0 || maxRaw === null ? null : Number.isInteger(Number(maxRaw)) && Number(maxRaw) >= 0 ? Number(maxRaw) : null;
  return { mode, time: time2, tz, hours, maxRechecks };
}
function nextCheckAt(policy, fromMs) {
  if (policy.mode === "after_hours") return fromMs + policy.hours * 36e5;
  const { hour, minute } = parseClock(policy.time);
  const local = zoneParts(fromMs, policy.tz);
  if (policy.mode === "next_day_at") {
    const nextDay = normalizeDate(local.year, local.month, local.day + 1);
    return wallToUtc(policy.tz, nextDay.year, nextDay.month, nextDay.day, hour, minute);
  }
  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = normalizeDate(local.year, local.month, local.day + offset);
    const weekday = weekdayOf(candidate.year, candidate.month, candidate.day);
    if (weekday === 0 || weekday === 6) continue;
    return wallToUtc(policy.tz, candidate.year, candidate.month, candidate.day, hour, minute);
  }
  throw stateInvalid("\u65E0\u6CD5\u8BA1\u7B97\u4E0B\u4E00\u5DE5\u4F5C\u65E5\uFF1A\u65E5\u671F\u6EDA\u52A8\u8D85\u8FC7 8 \u5929");
}
function parseReviewPolicy(json2) {
  const fallback = { approver: "owner", expiresHours: 24, autoClose: false };
  if (!json2 || !json2.trim()) return fallback;
  let raw;
  try {
    raw = JSON.parse(json2);
  } catch {
    throw stateInvalid(`review_policy_json \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${json2}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const item = raw;
  const approver = typeof item.approver === "string" && item.approver.trim() ? item.approver.trim() : fallback.approver;
  if (approver !== "owner" && !/^position:.+$/.test(approver)) {
    throw stateInvalid(`review_policy.approver \u53EA\u652F\u6301 owner \u6216 position:<id>\uFF0C\u6536\u5230 ${approver}`);
  }
  const expiresRaw = item.expires_hours ?? item.expiresHours ?? fallback.expiresHours;
  const expiresHours = Number(expiresRaw);
  if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
    throw stateInvalid(`review_policy.expires_hours \u5FC5\u987B\u662F\u6B63\u6570\uFF1A${String(expiresRaw)}`);
  }
  const autoClose = item.auto_close === true || item.autoClose === true;
  return { approver, expiresHours, autoClose };
}

// src/service/permissions.ts
var CAPABILITY = {
  workItemCreate: "work_item.create",
  workItemAccept: "work_item.accept",
  workItemManage: "work_item.manage",
  workItemClaim: "work_item.claim",
  workItemExecute: "work_item.execute",
  workItemRequestClosure: "work_item.request_closure",
  evidenceAppend: "evidence.append",
  checkEvaluate: "check.evaluate",
  proposalCreate: "proposal.create",
  proposalDecide: "proposal.decide",
  approvalDecide: "approval.decide",
  connectorIngest: "connector.ingest",
  // M6：项目 / 指标 / 知识（人的能力仍只从在岗岗位来）
  projectCreate: "project.create",
  projectManage: "project.manage",
  metricRecord: "metric.record",
  knowledgeWrite: "knowledge.write",
  knowledgeSync: "knowledge.sync"
};
function resolvePrincipal(db, memberId, nowMs) {
  const member = db.prepare("SELECT id, kind, name, role, status, current_version FROM member WHERE id = ?").get(memberId);
  if (!member) throw denied(`\u4E3B\u4F53\u4E0D\u5B58\u5728\uFF1A${memberId}`);
  if (member.status !== "active") throw denied(`\u4E3B\u4F53\u5DF2\u505C\u7528\uFF1A${member.name}`);
  const capabilities = /* @__PURE__ */ new Set();
  const positions = [];
  if (member.kind === "human") {
    const rows = db.prepare(
      `SELECT pp.capability AS capability, p.id AS position_id, p.name AS position_name
           FROM member_position mp
           JOIN position p ON p.id = mp.position_id AND p.status = 'active'
           JOIN position_permission pp ON pp.position_id = mp.position_id
          WHERE mp.member_id = ?
            AND mp.starts_at <= ?
            AND (mp.ends_at IS NULL OR mp.ends_at > ?)`
    ).all(member.id, nowMs, nowMs);
    for (const row of rows) {
      capabilities.add(row.capability);
      if (!positions.some((item) => item.positionId === row.position_id)) {
        positions.push({ positionId: row.position_id, name: row.position_name });
      }
    }
  } else if (member.kind === "bot") {
    const rows = db.prepare("SELECT capability FROM member_permission WHERE member_id = ?").all(member.id);
    for (const row of rows) capabilities.add(row.capability);
  }
  return {
    memberId: member.id,
    kind: member.kind,
    name: member.name,
    role: member.role,
    status: member.status,
    currentVersion: Number(member.current_version),
    positions,
    capabilities
  };
}
function requireCapability(principal, capability) {
  if (principal.kind === "system") return;
  if (!principal.capabilities.has(capability)) {
    throw denied(`\u300C${principal.name}\u300D\u6CA1\u6709 ${capability} \u80FD\u529B`, "\u786E\u8BA4\u5C97\u4F4D\u662F\u5426\u5728\u5C97\uFF0C\u6216\u7531\u7BA1\u7406\u5458\u8865\u5145\u6388\u6743");
  }
}
function requireHuman(principal) {
  if (principal.kind !== "human") throw denied("\u8BE5\u64CD\u4F5C\u53EA\u5141\u8BB8\u4EBA\u6267\u884C");
}
function requireBot(principal) {
  if (principal.kind !== "bot") throw denied("\u8BE5\u64CD\u4F5C\u53EA\u5141\u8BB8 bot \u6267\u884C");
}

// src/service/memory.ts
import { createHash as createHash5 } from "node:crypto";
var MEMORY_KINDS = ["fact", "decision", "preference", "lesson", "capability"];
var MEMORY_ORIGINS = ["auto", "manual", "tool"];
var MEMORY_STATUSES = ["active", "archived"];
var MEMORY_KIND_LABEL = {
  fact: "\u4E8B\u5B9E",
  decision: "\u51B3\u7B56",
  preference: "\u504F\u597D",
  lesson: "\u6559\u8BAD",
  capability: "\u80FD\u529B"
};
var MAX_TITLE = 120;
var MAX_BODY = 2e3;
function text3(value, field, max) {
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!trimmed) throw stateInvalid(`${field} \u4E0D\u80FD\u4E3A\u7A7A`);
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function optionalText2(value, field, max) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function oneOf2(value, field, allowed, fallback) {
  if ((value === void 0 || value === null || value === "") && fallback !== void 0) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw stateInvalid(`${field} \u53EA\u80FD\u662F ${allowed.join(" / ")}`);
  }
  return value;
}
function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}
function memoryDedupeKey(kind, title, body) {
  return createHash5("sha256").update(`${kind}
${normalize(title)}
${normalize(body)}`).digest("hex").slice(0, 32);
}
function projectOrThrow(db, projectId) {
  const row = db.prepare("SELECT id, status FROM project WHERE id = ? AND deleted_at IS NULL").get(projectId);
  if (!row) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`);
  return row;
}
function memoryView(db, projectId, dedupeKey) {
  return db.prepare(
    `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
           FROM project_memory m
           LEFT JOIN member mb ON mb.id = m.member_id
           LEFT JOIN member cb ON cb.id = m.created_by
          WHERE m.project_id = ? AND m.dedupe_key = ?`
  ).get(projectId, dedupeKey) ?? null;
}
function createMemory(db, ids, now, actorId, input) {
  const project = projectOrThrow(db, input.projectId);
  if (project.status === "archived") throw stateInvalid("\u5F52\u6863\u9879\u76EE\u53EA\u8BFB\uFF0C\u4E0D\u80FD\u518D\u5199\u8BB0\u5FC6");
  const kind = oneOf2(input.kind, "\u8BB0\u5FC6\u7C7B\u578B", MEMORY_KINDS);
  const origin = oneOf2(input.origin, "\u8BB0\u5FC6\u6765\u6E90", MEMORY_ORIGINS, "manual");
  const status = oneOf2(input.status, "\u8BB0\u5FC6\u72B6\u6001", MEMORY_STATUSES, "active");
  const title = text3(input.title, "\u8BB0\u5FC6\u6807\u9898", MAX_TITLE);
  const body = text3(input.body, "\u8BB0\u5FC6\u6B63\u6587", MAX_BODY);
  const sourceRef = optionalText2(input.sourceRef, "\u6765\u6E90", 200);
  const dedupeKey = optionalText2(input.dedupeKey, "\u53BB\u91CD\u952E", 160) || memoryDedupeKey(kind, title, body);
  let memberId = optionalText2(input.memberId, "\u5F52\u5C5E bot", 64);
  if (kind !== "capability") memberId = null;
  if (memberId) {
    const member = db.prepare("SELECT id, kind, status FROM member WHERE id = ?").get(memberId);
    if (!member || member.kind !== "bot") throw stateInvalid("\u80FD\u529B\u7C7B\u8BB0\u5FC6\u53EA\u80FD\u540C\u6B65\u7ED9 bot");
    if (member.status !== "active") throw stateInvalid(`${memberId} \u4E0D\u5728\u5C97\uFF0C\u6682\u4E0D\u540C\u6B65\u80FD\u529B\u8BB0\u5FC6`);
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO project_memory
         (id, project_id, kind, title, body, origin, status, member_id, source_ref,
          dedupe_key, created_by, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(ids(), input.projectId, kind, title, body, origin, status, memberId, sourceRef, dedupeKey, actorId, now, now);
  const created = Number(insert.changes ?? 0) > 0;
  const memory = memoryView(db, input.projectId, dedupeKey);
  if (!memory) throw stateInvalid("\u8BB0\u5FC6\u5199\u5165\u5931\u8D25");
  let syncedTo = null;
  if (kind === "capability" && memberId) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_memory (id, member_id, project_id, memory_id, kind, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ids(), memberId, input.projectId, memory.id, kind, title, body, now);
    syncedTo = memberId;
  }
  return { memory, created, syncedTo };
}
function updateMemory(db, now, input) {
  const row = db.prepare("SELECT * FROM project_memory WHERE id = ?").get(input.memoryId);
  if (!row) throw stateInvalid(`\u8BB0\u5FC6\u4E0D\u5B58\u5728\uFF1A${input.memoryId}`);
  const title = input.title === void 0 ? row.title : text3(input.title, "\u8BB0\u5FC6\u6807\u9898", MAX_TITLE);
  const body = input.body === void 0 ? row.body : text3(input.body, "\u8BB0\u5FC6\u6B63\u6587", MAX_BODY);
  const status = input.status === void 0 ? row.status : oneOf2(input.status, "\u8BB0\u5FC6\u72B6\u6001", MEMORY_STATUSES);
  const revision = Number(row.revision) + 1;
  db.prepare("UPDATE project_memory SET title = ?, body = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?").run(
    title,
    body,
    status,
    revision,
    now,
    row.id
  );
  if (row.kind === "capability" && row.member_id) {
    db.prepare("UPDATE bot_memory SET title = ?, body = ? WHERE memory_id = ?").run(title, body, row.id);
  }
  return db.prepare(
    `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
           FROM project_memory m
           LEFT JOIN member mb ON mb.id = m.member_id
           LEFT JOIN member cb ON cb.id = m.created_by
          WHERE m.id = ?`
  ).get(row.id) ?? { ...row, title, body, status, revision, member_name: null, created_by_name: null };
}
function listProjectMemories(db, filter) {
  projectOrThrow(db, filter.projectId);
  const clauses = ["m.project_id = ?"];
  const params = [filter.projectId];
  if (filter.status) {
    clauses.push("m.status = ?");
    params.push(oneOf2(filter.status, "\u8BB0\u5FC6\u72B6\u6001", MEMORY_STATUSES));
  }
  if (filter.kind) {
    clauses.push("m.kind = ?");
    params.push(oneOf2(filter.kind, "\u8BB0\u5FC6\u7C7B\u578B", MEMORY_KINDS));
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  return db.prepare(
    `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
         FROM project_memory m
         LEFT JOIN member mb ON mb.id = m.member_id
         LEFT JOIN member cb ON cb.id = m.created_by
        WHERE ${clauses.join(" AND ")}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit}`
  ).all(...params);
}
function listMemberMemories(db, memberId, limit = 50) {
  return db.prepare(
    `SELECT mm.*, p.name AS project_name
         FROM bot_memory mm
         LEFT JOIN project p ON p.id = mm.project_id
        WHERE mm.member_id = ?
        ORDER BY mm.created_at DESC, mm.id DESC
        LIMIT ?`
  ).all(memberId, Math.min(Math.max(limit, 1), 200));
}
function block(rows, title) {
  if (!rows.length) return "";
  const lines = rows.map((row) => {
    const body = normalize(row.body);
    const detail = body && body !== normalize(row.title) ? `\uFF1A${body.slice(0, 180)}` : "";
    return `- [${MEMORY_KIND_LABEL[row.kind] ?? row.kind}] ${row.title.slice(0, 80)}${detail}`;
  });
  return `\u3010${title}\u3011
${lines.join("\n")}`;
}
function projectMemoryBlock(db, projectId, limit = 8) {
  const rows = listProjectMemories(db, { projectId, status: "active", limit }).slice().reverse();
  return block(rows, `\u9879\u76EE\u8BB0\u5FC6 \xB7 ${rows.length} \u6761`);
}
function memberMemoryBlock(db, memberId, limit = 6) {
  const rows = listMemberMemories(db, memberId, limit).slice().reverse();
  if (!rows.length) return "";
  return `\u3010bot \u8BB0\u5FC6\uFF08\u4ECE\u9879\u76EE\u540C\u6B65\uFF09\u3011
${rows.map((row) => `- [${MEMORY_KIND_LABEL[row.kind] ?? row.kind}] ${row.title.slice(0, 80)}\uFF08${row.project_name ?? ""}\uFF09`).join("\n")}`;
}
var CUES = [
  ["decision", /(决定|定了|敲定|拍板|确定用|结论[:：是]|采用|统一用|以后都|默认用|就这么|最终方案)/],
  ["lesson", /(教训|踩坑|注意|下次|避免|问题出在|原因是|根因|不要再|容易错)/],
  ["preference", /(偏好|喜欢|不喜欢|习惯|优先|尽量|更希望|不希望|别用|不要用|最好)/],
  ["capability", /(我会|我能|擅长|可以处理|处理流程|步骤是|工具是|方法就是|做法是)/],
  ["fact", /(口径[:：]|定义是|数据来源|阈值|统计口径|事实[:：]|发现[:：]|结论[:：]|目前实际)/]
];
function makeTitle(body) {
  let title = body.replace(/^[@＠]\s*\S+\s*/, "").replace(/^(决定|结论|注意|教训|偏好|事实|发现|口径|定义)\s*[：:，,\s]\s*/, "").trim();
  if (title.length > 28) title = `${title.slice(0, 28)}\u2026`;
  if (title.length < 4) title = body.slice(0, 28);
  return title;
}
function extractMemoryCandidates(text4, ctx) {
  const clean = String(text4 || "").replace(/```[\s\S]*?```/g, " ").replace(/^\s*[@＠]\s*\S+\s*/, "");
  const sentences = clean.split(/(?<=[。！？!?；;])|\n+/).map((part) => part.trim()).filter(Boolean);
  const out = [];
  for (const body of sentences) {
    if (body.length < 8 || body.length > 240) continue;
    if (/^(收到|好的|好|明白|稍等|谢谢|ok|OK|可以)[。.!！]?$/.test(body)) continue;
    if (/[?？]\s*$/.test(body)) continue;
    const hit = CUES.find(([kind, pattern]) => pattern.test(body) && (kind !== "capability" || ctx.authorKind === "bot"));
    if (!hit) continue;
    out.push({
      kind: hit[0],
      title: makeTitle(body),
      body,
      memberId: hit[0] === "capability" ? ctx.authorId : null
    });
    if (out.length >= 2) break;
  }
  return out;
}

// src/service/members.ts
import { createHash as createHash6 } from "node:crypto";
var MEMBER_KINDS = ["human", "bot"];
var MEMBER_ROLES = ["coordinator", "executor", "observer"];
var MEMBER_STATUSES = ["active", "paused", "retired"];
var MAX_NAME2 = 60;
var MAX_TEXT = 500;
function requiredText(value, field, max = MAX_NAME2) {
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!trimmed) throw stateInvalid(`${field} \u4E0D\u80FD\u4E3A\u7A7A`);
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function optionalText3(value, field, max = MAX_TEXT) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") throw stateInvalid(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw stateInvalid(`${field} \u8D85\u8FC7 ${max} \u5B57`);
  return trimmed;
}
function oneOf3(value, field, allowed, fallback) {
  if (value === void 0 && fallback !== void 0) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw stateInvalid(`${field} \u53EA\u80FD\u662F ${allowed.join(" / ")}`);
  }
  return value;
}
function capabilitiesOf(db, memberId, kind, now) {
  if (kind === "bot") {
    return db.prepare("SELECT capability FROM member_permission WHERE member_id = ?").all(memberId).map((row) => row.capability);
  }
  if (kind !== "human") return [];
  return db.prepare(
    `SELECT DISTINCT pp.capability AS capability
           FROM member_position mp
           JOIN position p ON p.id = mp.position_id AND p.status = 'active'
           JOIN position_permission pp ON pp.position_id = mp.position_id
          WHERE mp.member_id = ? AND mp.starts_at <= ? AND (mp.ends_at IS NULL OR mp.ends_at > ?)`
  ).all(memberId, now, now).map((row) => row.capability);
}
function workStats(db, memberId) {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS c FROM work_item
        WHERE owner_human_id = ? OR assignee_id = ?
        GROUP BY status`
  ).all(memberId, memberId);
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = Number(row.c);
    total += Number(row.c);
  }
  const closed = (byStatus.completed ?? 0) + (byStatus.cancelled ?? 0);
  return { total, open: total - closed, byStatus };
}
function positionsOf(db, memberId) {
  return db.prepare(
    `SELECT DISTINCT p.id, p.name FROM member_position mp
         JOIN position p ON p.id = mp.position_id
        WHERE mp.member_id = ? AND mp.ends_at IS NULL
        ORDER BY p.name`
  ).all(memberId);
}
function listMembers(db, now, filter = {}) {
  const clauses = ["m.kind <> 'system'"];
  const params = [];
  if (filter.projectId) {
    clauses.push("m.scope_project_id = ?");
    params.push(filter.projectId);
  } else {
    clauses.push("m.scope_project_id IS NULL");
  }
  if (filter.kind) {
    clauses.push("m.kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    clauses.push("m.status = ?");
    params.push(filter.status);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);
  const rows = db.prepare(
    `SELECT m.*, o.name AS owner_name,
              (SELECT COUNT(*) FROM task_run r WHERE r.member_id = m.id) AS run_total,
              (SELECT MAX(r.created_at) FROM task_run r WHERE r.member_id = m.id) AS last_run_at
         FROM member m
         LEFT JOIN member o ON o.id = m.owner_human_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE m.kind WHEN 'bot' THEN 1 ELSE 0 END, m.status, m.name
        LIMIT ${limit}`
  ).all(...params);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    domain: row.domain,
    responsibility: row.responsibility,
    role: row.role,
    status: row.status,
    current_version: Number(row.current_version),
    owner_human_id: row.owner_human_id,
    owner_name: row.owner_name,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    positions: positionsOf(db, row.id),
    // 停用 / 退休的主体按 resolvePrincipal 的口径不再拥有任何能力（界面显示为空）。
    capabilities: row.status === "active" ? capabilitiesOf(db, row.id, row.kind, now).sort() : [],
    work: workStats(db, row.id),
    runs: { total: Number(row.run_total), last_at: row.last_run_at === null ? null : Number(row.last_run_at) }
  }));
}
function getMember(db, now, memberId) {
  const scope = db.prepare("SELECT scope_project_id FROM member WHERE id = ?").get(memberId);
  if (!scope) throw stateInvalid(`\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${memberId}`);
  const summary = listMembers(db, now, {
    ...scope.scope_project_id ? { projectId: scope.scope_project_id } : {},
    limit: 200
  }).find((item) => item.id === memberId);
  if (!summary) throw stateInvalid(`\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${memberId}`);
  const positionHistory = db.prepare(
    `SELECT mp.position_id, p.name AS position_name, mp.starts_at, mp.ends_at, mp.assigned_by
         FROM member_position mp JOIN position p ON p.id = mp.position_id
        WHERE mp.member_id = ?
        ORDER BY mp.starts_at DESC`
  ).all(memberId);
  const permissions = db.prepare(
    `SELECT capability, scope, granted_by, granted_at FROM member_permission
        WHERE member_id = ? ORDER BY capability, scope`
  ).all(memberId);
  const recentWork = db.prepare(
    `SELECT id, title, status, project_id, owner_human_id, assignee_id, due_at, next_action_at, updated_at
         FROM work_item WHERE owner_human_id = ? OR assignee_id = ?
        ORDER BY updated_at DESC LIMIT 10`
  ).all(memberId, memberId);
  const recentRuns = db.prepare(
    `SELECT id, work_item_id, status, trigger, started_at, finished_at, created_at
         FROM task_run WHERE member_id = ?
        ORDER BY created_at DESC LIMIT 10`
  ).all(memberId);
  const botVersions = db.prepare(
    `SELECT id, version, model, agent_preset, prompt, change_class, published_by, published_at
         FROM member_version WHERE member_id = ?
        ORDER BY version DESC LIMIT 10`
  ).all(memberId);
  const subagent = db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`member:${memberId}:subagent`);
  const login = db.prepare(
    `SELECT id, login, display_name, auth_source, is_admin, status, last_login_at
         FROM hams_user WHERE member_id = ? LIMIT 1`
  ).get(memberId) ?? null;
  return {
    ...summary,
    position_history: positionHistory.map((item) => ({
      ...item,
      starts_at: Number(item.starts_at),
      ends_at: item.ends_at === null ? null : Number(item.ends_at),
      active: item.ends_at === null
    })),
    permissions: permissions.map((item) => ({ ...item, granted_at: Number(item.granted_at) })),
    recent_work: recentWork.map((item) => ({
      ...item,
      due_at: item.due_at === null ? null : Number(item.due_at),
      next_action_at: item.next_action_at === null ? null : Number(item.next_action_at),
      updated_at: Number(item.updated_at)
    })),
    recent_runs: recentRuns.map((item) => ({
      ...item,
      started_at: item.started_at === null ? null : Number(item.started_at),
      finished_at: item.finished_at === null ? null : Number(item.finished_at),
      created_at: Number(item.created_at)
    })),
    bot_versions: botVersions.map((item) => ({ ...item, version: Number(item.version), published_at: Number(item.published_at) })),
    subagent_session_id: subagent?.value ?? null,
    login
  };
}
function listPositions(db) {
  const positions = db.prepare("SELECT id, name, domain, description, status FROM position ORDER BY name").all();
  return positions.map((position) => ({
    ...position,
    capabilities: db.prepare("SELECT capability, scope FROM position_permission WHERE position_id = ? ORDER BY capability, scope").all(position.id),
    holders: Number(
      db.prepare(
        `SELECT COUNT(*) AS c FROM member_position
              WHERE position_id = ? AND ends_at IS NULL`
      ).get(position.id).c
    )
  }));
}
var BOT_GRANTABLE_CAPABILITIES = [
  CAPABILITY.workItemCreate,
  CAPABILITY.workItemClaim,
  CAPABILITY.workItemExecute,
  CAPABILITY.workItemRequestClosure,
  CAPABILITY.evidenceAppend,
  CAPABILITY.checkEvaluate,
  CAPABILITY.proposalCreate,
  CAPABILITY.connectorIngest,
  CAPABILITY.metricRecord,
  CAPABILITY.knowledgeWrite
];
function insertMember(db, ids, now, actorId, input) {
  const kind = oneOf3(input.kind, "\u6210\u5458\u7C7B\u578B", MEMBER_KINDS);
  const name2 = requiredText(input.name, "\u59D3\u540D");
  const role = oneOf3(input.role, "\u89D2\u8272", MEMBER_ROLES, "executor");
  const domain = optionalText3(input.domain, "\u4E1A\u52A1\u57DF", 40);
  const responsibility = optionalText3(input.responsibility, "\u804C\u8D23", MAX_TEXT) ?? "";
  const duplicate = db.prepare("SELECT id FROM member WHERE name = ?").get(name2);
  if (duplicate) throw stateInvalid(`\u6210\u5458\u540D\u5DF2\u5B58\u5728\uFF1A${name2}`, "\u6362\u4E00\u4E2A\u540D\u5B57\uFF0C\u6216\u6253\u5F00\u5DF2\u6709\u6210\u5458");
  const id = ids();
  if (kind === "human") {
    const positionId = requiredText(input.positionId, "\u5C97\u4F4D");
    const position = db.prepare("SELECT id, status FROM position WHERE id = ?").get(positionId);
    if (!position) throw stateInvalid(`\u5C97\u4F4D\u4E0D\u5B58\u5728\uFF1A${positionId}`, "\u5148\u5728\u5C97\u4F4D\u5217\u8868\u91CC\u9009\u4E00\u4E2A");
    if (position.status !== "active") throw stateInvalid(`\u5C97\u4F4D\u5DF2\u505C\u7528\uFF1A${positionId}`);
    db.prepare(
      `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                           owner_human_id, created_at, updated_at)
       VALUES (?, 'human', ?, ?, ?, ?, 'active', 0, NULL, ?, ?)`
    ).run(id, name2, domain, responsibility, role, now, now);
    db.prepare(
      `INSERT INTO member_position (member_id, position_id, starts_at, ends_at, assigned_by)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(id, positionId, now, actorId);
    return { id, kind, version: 0, capabilities: capabilitiesOf(db, id, kind, now).sort() };
  }
  const ownerId = optionalText3(input.ownerHumanId, "\u8D23\u4EFB\u4EBA", 64) ?? actorId;
  const owner = db.prepare("SELECT id, kind FROM member WHERE id = ?").get(ownerId);
  if (!owner || owner.kind !== "human") throw stateInvalid("bot \u7684\u8D23\u4EFB\u4EBA\u5FC5\u987B\u662F\u5B58\u5728\u7684\u4EBA");
  const agentPreset = optionalText3(input.agentPreset, "agent preset", 80);
  const model = optionalText3(input.model, "\u6A21\u578B", 120);
  const prompt = optionalText3(input.prompt, "\u63D0\u793A\u8BCD", 8192) ?? responsibility;
  const granted = [...new Set(Array.isArray(input.capabilities) ? input.capabilities : [])];
  for (const capability of granted) {
    if (!BOT_GRANTABLE_CAPABILITIES.includes(capability)) {
      throw stateInvalid(`bot \u4E0D\u80FD\u83B7\u5F97\u80FD\u529B\uFF1A${capability}`, "\u5BA1\u6279\u3001\u53D1\u5E03\u3001\u6210\u5458\u7BA1\u7406\u53EA\u80FD\u7ED9\u4EBA");
    }
  }
  const scope = optionalText3(input.scope, "\u6388\u6743\u8303\u56F4", 80) ?? "global";
  if (!/^(global|domain:[^:]+|project:[^:]+)$/.test(scope)) {
    throw stateInvalid("\u6388\u6743\u8303\u56F4\u53EA\u80FD\u662F global / domain:<\u57DF> / project:<id>");
  }
  const promptDigest = createHash6("sha256").update(JSON.stringify({ name: name2, responsibility, agentPreset, model, prompt })).digest("hex");
  db.prepare(
    `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                         owner_human_id, created_at, updated_at)
     VALUES (?, 'bot', ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
  ).run(id, name2, domain, responsibility, role, ownerId, now, now);
  db.prepare(
    `INSERT INTO member_version
       (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
        change_class, published_by, published_at)
     VALUES (?, ?, 1, ?, ?, '{}', ?, ?, 'major', ?, ?)`
  ).run(ids(), id, agentPreset, model, prompt, promptDigest, actorId, now);
  const grant = db.prepare(
    `INSERT INTO member_permission (member_id, capability, scope, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const capability of [...granted].sort()) grant.run(id, capability, scope, actorId, now);
  return { id, kind, version: 1, capabilities: capabilitiesOf(db, id, kind, now).sort() };
}
function setMemberStatus(db, now, actorId, memberId, to) {
  const row = db.prepare("SELECT * FROM member WHERE id = ?").get(memberId);
  if (!row) throw stateInvalid(`\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${memberId}`);
  if (row.kind === "system") throw stateInvalid("\u7CFB\u7EDF\u4E3B\u4F53\u4E0D\u80FD\u505C\u7528");
  if (memberId === actorId) throw stateInvalid("\u4E0D\u80FD\u6539\u53D8\u81EA\u5DF1\u7684\u72B6\u6001", "\u8BF7\u7531\u53E6\u4E00\u540D\u6709\u6210\u5458\u7BA1\u7406\u6743\u9650\u7684\u4EBA\u64CD\u4F5C");
  const target = oneOf3(to, "\u6210\u5458\u72B6\u6001", MEMBER_STATUSES);
  const before = row.status;
  if (before === target) return { before, after: target, closedPositions: 0 };
  const allowed = {
    active: ["paused", "retired"],
    paused: ["active", "retired"],
    retired: ["active"]
  };
  if (!allowed[before]?.includes(target)) {
    throw stateInvalid(`\u6210\u5458\u72B6\u6001\u4E0D\u80FD\u4ECE ${before} \u6539\u4E3A ${target}`);
  }
  db.prepare("UPDATE member SET status = ?, updated_at = ? WHERE id = ?").run(target, now, memberId);
  let closed = 0;
  if (target === "retired" && row.kind === "human") {
    const result = db.prepare(
      `UPDATE member_position
            SET ends_at = CASE WHEN starts_at >= ? THEN starts_at + 1 ELSE ? END
          WHERE member_id = ? AND ends_at IS NULL`
    ).run(now, now, memberId);
    closed = Number(result.changes ?? 0);
  }
  return { before, after: target, closedPositions: closed };
}

// src/service/knowledge.ts
import { createHash as createHash7 } from "node:crypto";
import {
  copyFileSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import path4 from "node:path";
var MAX_PREVIEW_CHARS = 16e3;
var MAX_DOC_BYTES = 512 * 1024;
var MAX_IMPORT_BYTES = 2 * 1024 * 1024;
var MAX_IMPORT_FILES = 500;
var KNOWLEDGE_TABLE_SOURCES = [
  "work_item",
  "project",
  "member",
  "evidence",
  "work_template",
  "task_run",
  "approval",
  "proposal",
  "work_item_check",
  "metric_observation",
  "asset",
  "audit_log"
];
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "_build", ".git", "dist", ".venv", "venv", "__pycache__", ".cache"]);
var DENY_PATH_FRAGMENTS = ["/.dsh/sessions", "/.ssh", "/.aws", "/.gnupg", "/Library/Keychains"];
function sha256(text4) {
  return createHash7("sha256").update(text4).digest("hex");
}
function clampPreview(text4) {
  if (text4.length <= MAX_PREVIEW_CHARS) return { content: text4, truncated: false };
  return { content: `${text4.slice(0, MAX_PREVIEW_CHARS)}

\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u5171 ${text4.length} \u5B57\u7B26\uFF09`, truncated: true };
}
function parseFrontmatter(text4) {
  if (!text4.startsWith("---")) return { meta: {}, body: text4 };
  const end = text4.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text4 };
  const block2 = text4.slice(3, end);
  const meta = {};
  for (const line of block2.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    meta[match[1]] = value;
  }
  const after = text4.slice(end + 4);
  return { meta, body: after.replace(/^\r?\n/, "") };
}
function titleOfFile(text4, fallback) {
  const { meta, body } = parseFrontmatter(text4);
  if (meta.title && meta.title.trim()) return meta.title.trim();
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return fallback.replace(/\.(md|markdown)$/i, "");
}
function isDeniedPath(target) {
  const normalized = target.replace(/\\/g, "/");
  return DENY_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
function expandHome(input) {
  if (input === "~") return homedir2();
  if (input.startsWith("~/")) return path4.join(homedir2(), input.slice(2));
  return input;
}
function slug(name2, fallbackSeed) {
  const ascii = name2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 40);
  return `s-${sha256(fallbackSeed).slice(0, 8)}`;
}
function columnList(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => ({ name: row.name, type: row.type, notnull: Number(row.notnull), pk: Number(row.pk) }));
}
function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}
var KnowledgeService = class {
  db;
  now;
  ids;
  dataDir;
  skillDirs;
  constructor(options) {
    this.db = options.db;
    this.now = options.now;
    this.ids = options.idFactory;
    this.dataDir = path4.resolve(options.dataDir);
    this.skillDirs = (options.skillDirs ?? []).map((dir) => path4.resolve(expandHome(dir)));
  }
  get docsDir() {
    return path4.join(this.dataDir, "knowledge", "docs");
  }
  getSkillsDirs() {
    return [...this.skillDirs];
  }
  // ───────────────────────── 读 ─────────────────────────
  list(filter = {}) {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    const docs = this.listDocs();
    const skills = this.listSkills();
    const tables = this.listTables();
    const counts = { docs: docs.length, skills: skills.length, tables: tables.length };
    let items = [];
    if (!filter.kind || filter.kind === "doc") items.push(...docs);
    if (!filter.kind || filter.kind === "skill") items.push(...skills);
    if (!filter.kind || filter.kind === "table") items.push(...tables);
    const q = (filter.q ?? "").trim().toLowerCase();
    if (q) {
      items = items.filter((item) => {
        const name2 = "name" in item ? item.name : "";
        const title = "title" in item ? item.title : "";
        return `${item.id} ${name2} ${title} ${item.subtitle}`.toLowerCase().includes(q);
      });
    }
    items.sort((a, b) => {
      const ta = a.kind === "doc" ? a.updated_at : a.kind === "skill" ? a.published_at ?? a.created_at : a.updated_at;
      const tb = b.kind === "doc" ? b.updated_at : b.kind === "skill" ? b.published_at ?? b.created_at : b.updated_at;
      return tb - ta;
    });
    return {
      items: items.slice(0, limit),
      counts,
      sources: { skill_dirs: this.getSkillsDirs(), docs_dir: this.docsDir, tables: tables.length }
    };
  }
  listDocs() {
    const rows = this.db.prepare(
      `SELECT d.*, m.name AS owner_name FROM kb_doc d
           LEFT JOIN member m ON m.id = d.owner_id
          ORDER BY d.updated_at DESC`
    ).all();
    return rows.map((row) => ({
      kind: "doc",
      id: row.id,
      title: row.title,
      subtitle: row.source_kind === "file" ? row.body_ref : "HAMS \u5185\u64B0\u5199",
      status: row.status,
      source_kind: row.source_kind,
      revision: Number(row.revision),
      bytes: Number(row.bytes),
      updated_at: Number(row.updated_at),
      owner_id: row.owner_id,
      owner_name: row.owner_name,
      path: row.body_ref
    }));
  }
  listSkills() {
    const rows = this.db.prepare(
      `SELECT s.*, v.version AS version, v.content_hash AS content_hash, v.published_at AS published_at,
                v.manifest_json AS manifest_json
           FROM kb_skill s
           LEFT JOIN kb_skill_version v ON v.id = s.published_version_id
          ORDER BY COALESCE(v.published_at, s.created_at) DESC`
    ).all();
    return rows.map((row) => {
      const manifest = this.parseManifest(row.manifest_json);
      const filePath = typeof manifest.path === "string" ? manifest.path : null;
      return {
        kind: "skill",
        id: row.id,
        name: row.name,
        subtitle: typeof manifest.description === "string" ? manifest.description : row.domain ?? "",
        version: row.version,
        content_hash: row.content_hash,
        published_at: row.published_at === null ? null : Number(row.published_at),
        usage_count: Number(row.usage_count),
        path: filePath,
        present: Boolean(filePath && existsSync3(filePath)),
        created_at: Number(row.created_at)
      };
    });
  }
  listTables() {
    const rows = this.db.prepare("SELECT * FROM kb_table ORDER BY name").all();
    return rows.map((row) => {
      const schema = this.parseSchema(row.schema_json);
      return {
        kind: "table",
        id: row.id,
        name: row.name,
        subtitle: `${row.source_kind}${row.source_ref ? ` \xB7 ${row.source_ref}` : ""}`,
        source_kind: row.source_kind,
        source_ref: row.source_ref,
        columns: schema.columns.length,
        row_count: this.liveRowCount(row.source_kind, row.source_ref),
        updated_at: Number(row.updated_at)
      };
    });
  }
  get(kind, id) {
    if (kind === "doc") return this.getDoc(id);
    if (kind === "skill") return this.getSkill(id);
    if (kind === "table") return this.getTable(id);
    throw stateInvalid("\u77E5\u8BC6\u7C7B\u578B\u53EA\u80FD\u662F doc / skill / table");
  }
  getDoc(id) {
    const row = this.db.prepare("SELECT * FROM kb_doc WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u6587\u6863\u4E0D\u5B58\u5728\uFF1A${id}`);
    const owner = this.db.prepare("SELECT name FROM member WHERE id = ?").get(row.owner_id);
    const file = this.readFileSafe(row.body_ref);
    const currentHash = file.ok ? sha256(file.text) : "";
    const changed = Boolean(file.ok && row.content_hash && currentHash !== row.content_hash);
    const bodyText = file.ok ? parseFrontmatter(file.text).body : "";
    const preview = clampPreview(file.ok ? bodyText : "\uFF08\u6E90\u6587\u4EF6\u6682\u65F6\u8BFB\u4E0D\u5230\uFF1B\u5148\u786E\u8BA4\u8DEF\u5F84\u6216\u91CD\u65B0\u5BFC\u5165\uFF09");
    return {
      kind: "doc",
      id: row.id,
      title: row.title,
      subtitle: row.source_kind === "file" ? row.body_ref : "HAMS \u5185\u64B0\u5199",
      status: row.status,
      source_kind: row.source_kind,
      revision: Number(row.revision),
      bytes: Number(row.bytes),
      updated_at: Number(row.updated_at),
      owner_id: row.owner_id,
      owner_name: owner?.name ?? null,
      path: row.body_ref,
      present: file.ok,
      changed,
      content: preview.content,
      truncated: preview.truncated,
      file_bytes: file.ok ? Buffer.byteLength(file.text, "utf8") : null
    };
  }
  getSkill(id) {
    const skill = this.listSkills().find((item) => item.id === id);
    if (!skill) throw stateInvalid(`\u6280\u80FD\u4E0D\u5B58\u5728\uFF1A${id}`);
    const versionRow = this.db.prepare("SELECT * FROM kb_skill_version WHERE id = (SELECT published_version_id FROM kb_skill WHERE id = ?)").get(id);
    const manifest = this.parseManifest(versionRow?.manifest_json ?? null);
    const preview = skill.path ? this.readFileSafe(skill.path) : { ok: false, text: "" };
    const bodyText = preview.ok ? parseFrontmatter(preview.text).body : "";
    const content = clampPreview(preview.ok ? bodyText : "\uFF08\u6280\u80FD\u6E90\u6587\u4EF6\u4E0D\u5728\u78C1\u76D8\u4E0A\u4E86\uFF1B\u5386\u53F2\u7248\u672C\u4ECD\u4FDD\u7559\uFF09");
    const versions = this.db.prepare(
      `SELECT id, version, status, content_hash, published_by, published_at
           FROM kb_skill_version WHERE skill_id = ? ORDER BY published_at DESC, rowid DESC LIMIT 10`
    ).all(id);
    return {
      ...skill,
      description: typeof manifest.description === "string" ? manifest.description : null,
      when_to_use: typeof manifest.whenToUse === "string" ? manifest.whenToUse : null,
      content: content.content,
      truncated: content.truncated,
      versions: versions.map((item) => ({
        ...item,
        published_at: item.published_at === null ? null : Number(item.published_at)
      }))
    };
  }
  getTable(id) {
    const row = this.db.prepare("SELECT * FROM kb_table WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u6570\u636E\u8868\u4E0D\u5B58\u5728\uFF1A${id}`);
    const schema = this.parseSchema(row.schema_json);
    return {
      kind: "table",
      id: row.id,
      name: row.name,
      subtitle: `${row.source_kind}${row.source_ref ? ` \xB7 ${row.source_ref}` : ""}`,
      source_kind: row.source_kind,
      source_ref: row.source_ref,
      columns: schema.columns.length,
      row_count: this.liveRowCount(row.source_kind, row.source_ref),
      updated_at: Number(row.updated_at),
      columns_detail: schema.columns,
      live: this.isLiveLocalTable(row.source_kind, row.source_ref)
    };
  }
  // ───────────────────────── 同步（真实来源） ─────────────────────────
  sync(actorId) {
    const at = this.now();
    const report = {
      at,
      skills: { roots: this.skillDirs.length, scanned: 0, created: 0, updated: 0, unchanged: 0, missing: 0, errors: [] },
      tables: { created: 0, updated: 0, unchanged: 0, errors: [] }
    };
    if (!this.skillDirs.length) {
      report.skills.errors.push("\u6CA1\u6709\u914D\u7F6E\u6280\u80FD\u76EE\u5F55\uFF08\u9ED8\u8BA4\u5E94\u4E3A $DSH_HOME/skills\uFF09");
    }
    for (const root of this.skillDirs) {
      if (!existsSync3(root)) {
        report.skills.errors.push(`\u6280\u80FD\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${root}`);
        continue;
      }
      let entries;
      try {
        entries = readdirSync2(root, { withFileTypes: true });
      } catch (error) {
        report.skills.errors.push(`\u8BFB\u4E0D\u4E86\u6280\u80FD\u76EE\u5F55 ${root}\uFF1A${error.message}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const file = path4.join(root, entry.name, "SKILL.md");
        if (!existsSync3(file)) continue;
        try {
          const before = this.db.prepare("SELECT id FROM kb_skill WHERE name = ?").get(entry.name);
          const result = this.syncSkillFile(actorId, file, entry.name, before?.id);
          report.skills.scanned += 1;
          if (result === "created") report.skills.created += 1;
          else if (result === "updated") report.skills.updated += 1;
          else report.skills.unchanged += 1;
        } catch (error) {
          report.skills.errors.push(`${file}\uFF1A${error.message}`);
        }
      }
    }
    report.skills.missing = this.countMissingSkills();
    for (const table of KNOWLEDGE_TABLE_SOURCES) {
      try {
        if (!tableExists(this.db, table)) continue;
        const outcome = this.syncTable(table, at);
        if (outcome === "created") report.tables.created += 1;
        else if (outcome === "updated") report.tables.updated += 1;
        else report.tables.unchanged += 1;
      } catch (error) {
        report.tables.errors.push(`${table}\uFF1A${error.message}`);
      }
    }
    return report;
  }
  syncSkillFile(actorId, file, dirName, existingId) {
    const text4 = readFileSync2(file, "utf8");
    const hash = sha256(text4);
    const { meta } = parseFrontmatter(text4);
    const name2 = (meta.name || dirName).trim();
    const skill = existingId ? this.db.prepare("SELECT * FROM kb_skill WHERE id = ?").get(existingId) : void 0;
    const now = this.now();
    const manifest = JSON.stringify({
      source: "host-skills",
      name: name2,
      description: meta.description ?? "",
      whenToUse: meta.whenToUse ?? "",
      path: file,
      root: path4.dirname(path4.dirname(file)),
      bytes: Buffer.byteLength(text4, "utf8"),
      mtime: statSync2(file).mtimeMs,
      syncedAt: now
    });
    if (skill?.published_version_id) {
      const published = this.db.prepare("SELECT content_hash FROM kb_skill_version WHERE id = ?").get(skill.published_version_id);
      if (published && published.content_hash === hash) return "unchanged";
    }
    let id = skill?.id;
    let created = false;
    if (!id) {
      const byName = this.db.prepare("SELECT id FROM kb_skill WHERE name = ?").get(name2);
      if (byName) id = byName.id;
    }
    if (!id) {
      id = `ks-${slug(name2, file)}`;
      if (this.db.prepare("SELECT 1 FROM kb_skill WHERE id = ?").get(id)) id = `ks-${slug(name2, file)}-${hash.slice(0, 6)}`;
      this.db.prepare("INSERT INTO kb_skill (id, name, domain, published_version_id, usage_count, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(
        id,
        name2,
        meta.domain ?? null,
        now
      );
      created = true;
    }
    this.db.prepare("UPDATE kb_skill_version SET status = 'retired' WHERE skill_id = ? AND status = 'published'").run(id);
    let version = `sync-${hash.slice(0, 12)}`;
    const clash = this.db.prepare("SELECT 1 FROM kb_skill_version WHERE skill_id = ? AND version = ?").get(id, version);
    if (clash) version = `${version}-${now.toString(36)}`;
    const versionId = this.ids();
    this.db.prepare(
      `INSERT INTO kb_skill_version
         (id, skill_id, version, manifest_json, content_hash, status, authored_by, published_by, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`
    ).run(versionId, id, version, manifest, hash, actorId, actorId, now);
    this.db.prepare("UPDATE kb_skill SET published_version_id = ?, name = ?, domain = ? WHERE id = ?").run(
      versionId,
      name2,
      meta.domain ?? null,
      id
    );
    return created ? "created" : "updated";
  }
  countMissingSkills() {
    const rows = this.db.prepare(
      `SELECT v.manifest_json FROM kb_skill s
           JOIN kb_skill_version v ON v.id = s.published_version_id`
    ).all();
    let missing = 0;
    for (const row of rows) {
      const manifest = this.parseManifest(row.manifest_json);
      if (typeof manifest.path === "string" && !existsSync3(manifest.path)) missing += 1;
    }
    return missing;
  }
  syncTable(table, at) {
    const columns = columnList(this.db, table);
    const schema = JSON.stringify({ table, columns });
    const id = `kt-${table}`;
    const existing = this.db.prepare("SELECT * FROM kb_table WHERE id = ?").get(id);
    if (!existing) {
      this.db.prepare(
        `INSERT INTO kb_table (id, name, source_kind, source_ref, schema_json, field_map_status, updated_at)
         VALUES (?, ?, 'local', ?, ?, 'ok', ?)`
      ).run(id, `HAMS \u4E1A\u52A1\u8868 \xB7 ${table}`, `hams:${table}`, schema, at);
      return "created";
    }
    if (existing.schema_json !== schema || existing.source_ref !== `hams:${table}`) {
      this.db.prepare("UPDATE kb_table SET schema_json = ?, source_ref = ?, updated_at = ? WHERE id = ?").run(schema, `hams:${table}`, at, id);
      return "updated";
    }
    return "unchanged";
  }
  // ───────────────────────── 写：文档 ─────────────────────────
  createDoc(actorId, input) {
    const title = String(input.title ?? "").trim();
    if (!title) throw stateInvalid("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
    if (title.length > 120) throw stateInvalid("\u6807\u9898\u8D85\u8FC7 120 \u5B57");
    const body = typeof input.body === "string" ? input.body : "";
    if (!body.trim()) throw stateInvalid("\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
    if (Buffer.byteLength(body, "utf8") > MAX_DOC_BYTES) throw stateInvalid(`\u6B63\u6587\u8D85\u8FC7 ${MAX_DOC_BYTES / 1024} KB`);
    const status = input.status === "published" ? "published" : "draft";
    const id = this.ids();
    const now = this.now();
    const file = path4.join(this.docsDir, `${id}.md`);
    mkdirSync4(this.docsDir, { recursive: true });
    const content = this.docFileContent({ title, body, ownerId: actorId, createdAt: now, revision: 1 });
    writeFileSync2(file, content, "utf8");
    this.db.prepare(
      `INSERT INTO kb_doc (id, title, body_ref, revision, owner_id, source_kind, content_hash, bytes, status, updated_at)
       VALUES (?, ?, ?, 1, ?, 'hams', ?, ?, ?, ?)`
    ).run(id, title, file, actorId, sha256(content), Buffer.byteLength(content, "utf8"), status, now);
    return { id, revision: 1, path: file };
  }
  updateDoc(actorId, docId, input, allowForeign) {
    const row = this.db.prepare("SELECT * FROM kb_doc WHERE id = ?").get(docId);
    if (!row) throw stateInvalid(`\u6587\u6863\u4E0D\u5B58\u5728\uFF1A${docId}`);
    if (row.source_kind !== "hams") throw stateInvalid("\u5BFC\u5165\u7684\u6587\u4EF6\u662F\u53EA\u8BFB\u955C\u50CF\uFF0C\u8BF7\u4FEE\u6539\u6E90\u6587\u4EF6\u540E\u91CD\u65B0\u5BFC\u5165");
    if (row.owner_id !== actorId && !allowForeign) throw stateInvalid("\u53EA\u6709\u4F5C\u8005\u6216\u6709\u6210\u5458\u7BA1\u7406\u6743\u9650\u7684\u4EBA\u80FD\u6539\u8FD9\u7BC7\u6587\u6863");
    if (input.expectedRevision !== void 0 && Number(input.expectedRevision) !== Number(row.revision)) {
      throw stateInvalid(`\u4FEE\u8BA2\u53F7\u5DF2\u53D8\uFF1A\u671F\u671B ${input.expectedRevision}\uFF0C\u5F53\u524D ${row.revision}`, "\u5237\u65B0\u540E\u6BD4\u8F83\u4E24\u7248\u5185\u5BB9\u518D\u63D0\u4EA4");
    }
    const title = input.title === void 0 ? row.title : String(input.title).trim();
    if (!title) throw stateInvalid("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
    const body = typeof input.body === "string" ? input.body : "";
    if (!body.trim()) throw stateInvalid("\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
    if (Buffer.byteLength(body, "utf8") > MAX_DOC_BYTES) throw stateInvalid(`\u6B63\u6587\u8D85\u8FC7 ${MAX_DOC_BYTES / 1024} KB`);
    const now = this.now();
    const revision = Number(row.revision) + 1;
    if (existsSync3(row.body_ref)) {
      copyFileSync(row.body_ref, path4.join(this.docsDir, `${docId}.v${row.revision}.md`));
    }
    const content = this.docFileContent({ title, body, ownerId: row.owner_id, createdAt: now, revision });
    mkdirSync4(this.docsDir, { recursive: true });
    writeFileSync2(row.body_ref, content, "utf8");
    this.db.prepare(
      `UPDATE kb_doc SET title = ?, content_hash = ?, bytes = ?, revision = ?, updated_at = ? WHERE id = ?`
    ).run(title, sha256(content), Buffer.byteLength(content, "utf8"), revision, now, docId);
    return { id: docId, revision, path: row.body_ref };
  }
  docFileContent(input) {
    const stamp2 = new Date(input.createdAt).toISOString();
    return [
      "---",
      `title: ${JSON.stringify(input.title)}`,
      `owner: ${input.ownerId}`,
      `revision: ${input.revision}`,
      `updated: ${stamp2}`,
      "---",
      "",
      input.body.replace(/\r\n/g, "\n").trimEnd(),
      ""
    ].join("\n");
  }
  publishDoc(actorId, docId, allowForeign) {
    const row = this.db.prepare("SELECT id, owner_id, status FROM kb_doc WHERE id = ?").get(docId);
    if (!row) throw stateInvalid(`\u6587\u6863\u4E0D\u5B58\u5728\uFF1A${docId}`);
    if (row.owner_id !== actorId && !allowForeign) throw stateInvalid("\u53EA\u6709\u4F5C\u8005\u6216\u6709\u6210\u5458\u7BA1\u7406\u6743\u9650\u7684\u4EBA\u80FD\u53D1\u5E03\u8FD9\u7BC7\u6587\u6863");
    if (row.status === "archived") throw stateInvalid("\u5DF2\u5F52\u6863\u7684\u6587\u6863\u4E0D\u80FD\u76F4\u63A5\u53D1\u5E03");
    if (row.status !== "published") {
      this.db.prepare("UPDATE kb_doc SET status = 'published', updated_at = ? WHERE id = ?").run(this.now(), docId);
    }
    return { id: docId, status: "published" };
  }
  /** 导入单个本机文件（工作区画像用）；返回 created / updated / skipped。 */
  importFile(actorId, file, options = {}) {
    const target = path4.resolve(expandHome(file));
    if (isDeniedPath(target)) throw stateInvalid("\u8FD9\u4E2A\u8DEF\u5F84\u4E0D\u5728\u5141\u8BB8\u5BFC\u5165\u7684\u8303\u56F4\u91CC\uFF08\u4F1A\u8BDD\u8BB0\u5F55\u3001\u5BC6\u94A5\u76EE\u5F55\u4E0D\u8BFB\uFF09");
    if (!existsSync3(target)) throw stateInvalid(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${target}`);
    if (!statSync2(target).isFile()) throw stateInvalid(`\u4E0D\u662F\u6587\u4EF6\uFF1A${target}`);
    return this.upsertImportedFile(actorId, target, options);
  }
  upsertImportedFile(actorId, file, options = {}) {
    const size = statSync2(file).size;
    if (size > MAX_IMPORT_BYTES) throw stateInvalid(`\u8D85\u8FC7 ${MAX_IMPORT_BYTES / 1024 / 1024} MB\uFF0C\u8DF3\u8FC7`);
    const text4 = readFileSync2(file, "utf8");
    const hash = sha256(text4);
    const existing = this.db.prepare("SELECT * FROM kb_doc WHERE body_ref = ?").get(file);
    if (existing) {
      if (existing.content_hash === hash) return "skipped";
      this.db.prepare(
        `UPDATE kb_doc SET title = ?, content_hash = ?, bytes = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`
      ).run(
        options.title ?? titleOfFile(text4, path4.basename(file)),
        hash,
        Buffer.byteLength(text4, "utf8"),
        this.now(),
        existing.id
      );
      return "updated";
    }
    const id = this.ids();
    const now = this.now();
    this.db.prepare(
      `INSERT INTO kb_doc (id, title, body_ref, revision, owner_id, source_kind, content_hash, bytes, status, updated_at)
       VALUES (?, ?, ?, 1, ?, 'file', ?, ?, ?, ?)`
    ).run(
      id,
      options.title ?? titleOfFile(text4, path4.basename(file)),
      file,
      actorId,
      hash,
      Buffer.byteLength(text4, "utf8"),
      options.status ?? "published",
      now
    );
    return "created";
  }
  importDocs(actorId, input) {
    const raw = String(input.dir ?? "").trim();
    if (!raw) throw stateInvalid("\u5BFC\u5165\u76EE\u5F55\u4E0D\u80FD\u4E3A\u7A7A");
    const dir = path4.resolve(expandHome(raw));
    if (isDeniedPath(dir)) throw stateInvalid("\u8FD9\u4E2A\u76EE\u5F55\u4E0D\u5728\u5141\u8BB8\u5BFC\u5165\u7684\u8303\u56F4\u91CC\uFF08\u4F1A\u8BDD\u8BB0\u5F55\u3001\u5BC6\u94A5\u76EE\u5F55\u4E0D\u8BFB\uFF09");
    if (!existsSync3(dir)) throw stateInvalid(`\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${dir}`);
    if (!statSync2(dir).isDirectory()) throw stateInvalid(`\u4E0D\u662F\u76EE\u5F55\uFF1A${dir}`);
    const recursive = input.recursive !== false;
    const maxFiles = Math.min(Math.max(Number(input.maxFiles ?? 200), 1), MAX_IMPORT_FILES);
    const report = { at: this.now(), dir, scanned: 0, imported: 0, updated: 0, skipped: 0, errors: [] };
    const files = [];
    const walk2 = (current, depth) => {
      let entries;
      try {
        entries = readdirSync2(current, { withFileTypes: true });
      } catch (error) {
        report.errors.push({ path: current, message: error.message });
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const name2 = entry.name;
        if (name2.startsWith(".") || SKIP_DIRS.has(name2)) continue;
        const full = path4.join(current, name2);
        if (entry.isDirectory()) {
          if (recursive && depth < 4) walk2(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|markdown)$/i.test(name2)) continue;
        files.push(full);
      }
    };
    walk2(dir, 0);
    for (const file of files) {
      report.scanned += 1;
      try {
        const outcome = this.upsertImportedFile(actorId, file);
        if (outcome === "created") report.imported += 1;
        else if (outcome === "updated") report.updated += 1;
        else report.skipped += 1;
      } catch (error) {
        report.errors.push({ path: file, message: error.message });
      }
    }
    return report;
  }
  // ───────────────────────── 内部 ─────────────────────────
  readFileSafe(file) {
    try {
      if (!file || !existsSync3(file)) return { ok: false, text: "" };
      const stat = statSync2(file);
      if (!stat.isFile()) return { ok: false, text: "" };
      return { ok: true, text: readFileSync2(file, "utf8") };
    } catch {
      return { ok: false, text: "" };
    }
  }
  parseManifest(raw) {
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  parseSchema(raw) {
    try {
      const value = JSON.parse(raw);
      return {
        columns: Array.isArray(value.columns) ? value.columns : []
      };
    } catch {
      return { columns: [] };
    }
  }
  isLiveLocalTable(sourceKind, sourceRef) {
    if (sourceKind !== "local" || !sourceRef?.startsWith("hams:")) return false;
    const table = sourceRef.slice(5);
    return /^[a-z_][a-z0-9_]*$/.test(table) && tableExists(this.db, table);
  }
  liveRowCount(sourceKind, sourceRef) {
    if (!this.isLiveLocalTable(sourceKind, sourceRef)) return null;
    const table = String(sourceRef).slice(5);
    try {
      return Number(this.db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
    } catch {
      return null;
    }
  }
};

// src/service/audit.ts
function writeAudit(db, id, entry) {
  db.prepare(
    `INSERT INTO audit_log
       (id, actor_id, actor_kind, on_behalf_of, channel, auth_subject, host_preset,
        action, subject_kind, subject_id, before_json, after_json, correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.actorId,
    entry.actorKind,
    entry.onBehalfOf ?? null,
    entry.channel,
    entry.authSubject ?? null,
    entry.hostPreset ?? null,
    entry.action,
    entry.subjectKind,
    entry.subjectId,
    entry.before === void 0 ? null : JSON.stringify(entry.before),
    entry.after === void 0 ? null : JSON.stringify(entry.after),
    entry.correlationId,
    entry.at
  );
}
function writeEvent(db, id, entry) {
  db.prepare(
    `INSERT INTO work_item_event
       (id, work_item_id, kind, actor_id, actor_kind, payload_json, revision, execution_epoch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.workItemId,
    entry.kind,
    entry.actorId,
    entry.actorKind,
    JSON.stringify(entry.payload ?? {}),
    entry.revision,
    entry.executionEpoch,
    entry.at
  );
}
function writeChange(db, entry) {
  db.prepare(
    `INSERT INTO change_log (object_kind, object_id, revision, change_kind, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(entry.objectKind, entry.objectId, entry.revision, entry.changeKind, entry.at);
}

// src/service/work-item-create.ts
function insertWorkItem(factory, input) {
  const { db } = factory;
  const at = factory.now();
  const owner = db.prepare("SELECT kind FROM member WHERE id = ?").get(input.ownerHumanId);
  if (!owner) throw stateInvalid(`\u8D1F\u8D23\u4EBA\u4E0D\u5B58\u5728\uFF1A${input.ownerHumanId}`);
  if (owner.kind !== "human") throw denied("\u5DE5\u4F5C\u9879\u8D1F\u8D23\u4EBA\u5FC5\u987B\u662F\u4EBA");
  let closeRequiresApproval = 1;
  if (input.templateVersionId) {
    const template = db.prepare("SELECT * FROM work_template_version WHERE id = ?").get(input.templateVersionId);
    if (!template) throw stateInvalid(`\u6A21\u677F\u7248\u672C\u4E0D\u5B58\u5728\uFF1A${input.templateVersionId}`);
    if (template.status !== "published") throw stateInvalid(`\u6A21\u677F\u7248\u672C\u672A\u53D1\u5E03\uFF1A${template.status}`);
    closeRequiresApproval = parseReviewPolicy(template.review_policy_json).autoClose ? 0 : 1;
  }
  if (input.projectId) consumeBudget(factory, input.projectId, at);
  const workItemId = factory.ids();
  db.prepare(
    `INSERT INTO work_item
       (id, project_id, parent_id, template_version_id, asset_id, domain, category, title, priority, status,
        owner_human_id, assignee_id, due_at, next_action_at, check_generation, close_requires_approval,
        dedupe_key, revision, execution_epoch, fence_seq, evidence_set_hash, created_by, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, ?, NULL, 0, ?, ?, 1, 1, 0, '', ?, ?, ?)`
  ).run(
    workItemId,
    input.projectId ?? null,
    input.templateVersionId ?? null,
    input.assetId ?? null,
    input.domain,
    input.category,
    input.title,
    input.priority ?? 0,
    input.ownerHumanId,
    input.dueAt ?? null,
    closeRequiresApproval,
    input.dedupeKey ?? null,
    input.createdBy,
    at,
    at
  );
  const item = db.prepare("SELECT * FROM work_item WHERE id = ?").get(workItemId);
  writeEvent(db, factory.ids(), {
    workItemId,
    kind: "work_item_created",
    actorId: input.createdBy,
    actorKind: input.actorKind,
    payload: {
      title: input.title,
      dedupeKey: input.dedupeKey ?? null,
      templateVersionId: input.templateVersionId ?? null
    },
    revision: item.revision,
    executionEpoch: item.execution_epoch,
    at
  });
  writeChange(db, {
    objectKind: "work_item",
    objectId: workItemId,
    revision: item.revision,
    changeKind: "created",
    at
  });
  return item;
}
function consumeBudget(factory, projectId, at) {
  const { db } = factory;
  const { dayStart, weekStart } = periodStarts(factory.timeZone, at);
  for (const [kind, start] of [
    ["day", dayStart],
    ["week", weekStart]
  ]) {
    const row = db.prepare(
      `SELECT used, limit_value FROM project_budget
          WHERE project_id = ? AND period_kind = ? AND period_start = ? AND metric = 'new_tasks'`
    ).get(projectId, kind, start);
    if (!row) continue;
    if (Number(row.used) >= Number(row.limit_value)) {
      throw denied(
        `\u9879\u76EE\u300C${kind === "day" ? "\u65E5" : "\u5468"}\u300D\u5EFA\u5355\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF08${row.used}/${row.limit_value}\uFF09`,
        "\u8C03\u9AD8\u989D\u5EA6\u6216\u7B49\u4E0B\u4E00\u4E2A\u5468\u671F"
      );
    }
    const updated = db.prepare(
      `UPDATE project_budget SET used = used + 1
          WHERE project_id = ? AND period_kind = ? AND period_start = ? AND metric = 'new_tasks' AND used < limit_value`
    ).run(projectId, kind, start);
    if (updated.changes !== 1) {
      throw denied(`\u9879\u76EE\u300C${kind === "day" ? "\u65E5" : "\u5468"}\u300D\u5EFA\u5355\u989D\u5EA6\u7ADE\u4E89\u5931\u8D25`, "\u5237\u65B0\u540E\u91CD\u8BD5");
    }
  }
}
function periodStarts(timeZone, at) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(at));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const date = new Date(Date.UTC(pick("year"), pick("month") - 1, pick("day")));
  const weekday = date.getUTCDay();
  const monday = new Date(date.getTime() - (weekday + 6) % 7 * 864e5);
  const format = (value) => value.toISOString().slice(0, 10);
  return { dayStart: format(date), weekStart: format(monday) };
}

// src/service/receipts.ts
import { createHash as createHash8 } from "node:crypto";
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
function hashPayload(value) {
  return createHash8("sha256").update(stableStringify(value)).digest("hex");
}
function receiptScopeKey(principalId, action, idempotencyKey) {
  return createHash8("sha256").update(`${principalId}\0${action}\0${idempotencyKey}`).digest("hex");
}
function loadReceipt(db, scopeKey) {
  const row = db.prepare("SELECT payload_hash, receipt_json FROM command_receipt WHERE scope_key = ?").get(scopeKey);
  return row ? { payloadHash: row.payload_hash, receiptJson: row.receipt_json } : void 0;
}
function saveReceipt(db, input) {
  db.prepare(
    `INSERT INTO command_receipt
       (scope_key, command_id, principal_id, action, payload_hash, receipt_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.scopeKey,
    input.commandId,
    input.principalId,
    input.action,
    input.payloadHash,
    input.receiptJson,
    input.at
  );
}

// src/service/hams.ts
var TERMINAL_ITEM_STATUSES = ["completed", "failed", "cancelled"];
var OPEN_ITEM_STATUSES = [
  "ready",
  "active",
  "waiting_check",
  "waiting_review",
  "blocked",
  "paused",
  "failed"
];
var HamsService = class {
  db;
  now;
  runtimeEpoch;
  id;
  timeZone;
  validators;
  knowledgeService;
  constructor(options) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.id = options.idFactory ?? createIdFactory(this.now);
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
    this.validators = options.validators ?? {};
    this.runtimeEpoch = options.runtimeEpoch ?? this.readRuntimeEpoch();
    this.knowledgeService = options.knowledge?.dataDir ? new KnowledgeService({
      db: this.db,
      now: this.now,
      idFactory: this.id,
      dataDir: options.knowledge.dataDir,
      skillDirs: options.knowledge.skillDirs
    }) : null;
  }
  // ───────────────────────── 读 ─────────────────────────
  whoami(ctx) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const { capabilities, ...rest } = principal;
    return { principal: rest, capabilities: [...capabilities].sort() };
  }
  getWorkItem(ctx, workItemId) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const item = this.workItemOrThrow(workItemId);
    const all = (table) => this.db.prepare(`SELECT * FROM ${table} WHERE work_item_id=? ORDER BY rowid`).all(item.id);
    const threads = all("work_item_thread");
    const thread = threads.find((t) => t.status === "active" || t.status === "pending_rotate") ?? null;
    const templateVersion = this.templateVersionTx(item.template_version_id);
    return {
      ...item,
      allowedActions: this.allowedActions(principal, item),
      events: all("work_item_event"),
      evidence: all("evidence"),
      runs: all("task_run"),
      approvals: this.db.prepare("SELECT * FROM approval WHERE subject_id=? AND subject_kind='work_item_close' ORDER BY created_at DESC").all(item.id),
      checks: all("work_item_check"),
      threads,
      thread,
      current_thread: thread,
      templateVersion,
      criteriaSnapshot: templateVersion ? { templateVersionId: templateVersion.id, requiredEvidence: JSON.parse(templateVersion.required_evidence_json), validatorKey: templateVersion.validator_key, validatorParams: JSON.parse(templateVersion.validator_params_json), checkPolicy: JSON.parse(templateVersion.check_policy_json), reviewPolicy: JSON.parse(templateVersion.review_policy_json) } : null,
      canEvaluateCheck: principal.capabilities.has(CAPABILITY.checkEvaluate) && item.status !== "paused"
    };
  }
  listWorkItems(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const clauses = [];
    const params = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.assigneeId) {
      clauses.push("assignee_id = ?");
      params.push(filter.assigneeId);
    }
    if (filter.ownerId) {
      clauses.push("owner_human_id = ?");
      params.push(filter.ownerId);
    }
    for (const [field, column] of [["projectId", "project_id"], ["domain", "domain"]]) {
      if (filter[field]) {
        clauses.push(`${column} = ?`);
        params.push(filter[field]);
      }
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM work_item ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all(...params);
  }
  listApprovals(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const clauses = [];
    const params = [];
    if (filter.approverId) {
      clauses.push("approver_id = ?");
      params.push(filter.approverId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM approval ${where} ORDER BY created_at DESC LIMIT 200`).all(...params);
  }
  /** 诊断页 / ops/health 用：只读计数，不触发任何写。 */
  health(ctx) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const count = (sql, ...params) => Number(this.db.prepare(sql).get(...params).c);
    return {
      schemaVersion: Number(this.db.prepare("PRAGMA user_version").get().user_version),
      runtimeEpoch: this.runtimeEpoch,
      now: this.now(),
      counts: {
        workItems: count("SELECT COUNT(*) AS c FROM work_item"),
        openWorkItems: count("SELECT COUNT(*) AS c FROM work_item WHERE status NOT IN ('completed','cancelled')"),
        pendingApprovals: count("SELECT COUNT(*) AS c FROM approval WHERE status = 'pending'"),
        activeRuns: count("SELECT COUNT(*) AS c FROM task_run WHERE status IN ('queued','running')"),
        dueChecks: count("SELECT COUNT(*) AS c FROM work_item_check WHERE status = 'scheduled' AND planned_due_at <= ?", this.now()),
        leases: count("SELECT COUNT(*) AS c FROM lease")
      }
    };
  }
  listChecks(ctx, workItemId) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    return this.db.prepare("SELECT * FROM work_item_check WHERE work_item_id = ? ORDER BY generation DESC").all(workItemId);
  }
  /**
   * 模板目录（只读）：建单要绑一个**已发布**的判据版本，否则申请关单会被拒。
   *
   * 只返回已发布版本；草稿/退役版本对界面没有意义（建单也选不了）。
   * 没有模板时返回空数组，界面要显式提示「先配模板」，而不是让人建出关不掉单。
   */
  listTemplates(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const where = filter.domain ? "WHERE t.domain = ?" : "";
    const params = filter.domain ? [filter.domain] : [];
    return this.db.prepare(
      `SELECT t.id, t.key, t.name, t.domain, t.category, t.published_version_id,
                v.version, v.status AS version_status, v.required_evidence_json,
                v.check_policy_json, v.review_policy_json
           FROM work_template t
           LEFT JOIN work_template_version v ON v.id = t.published_version_id
           ${where}
          ORDER BY t.name`
    ).all(...params);
  }
  listProposals(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const clauses = [];
    const params = [];
    if (filter.deciderId) {
      clauses.push("decider_id = ?");
      params.push(filter.deciderId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    for (const [field, column] of [["projectId", "project_id"], ["domain", "domain"]]) {
      if (filter[field]) {
        clauses.push(`${column} = ?`);
        params.push(filter[field]);
      }
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.db.prepare(`SELECT * FROM proposal ${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...params);
  }
  /**
   * 总览读模型（画板 ①）：待我把关、到期复查、执行与异常、状态计数。
   * 只读、不写审计；界面用「快照 + changes/since 游标」增量刷新。
   */
  overview(ctx) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const at = this.now();
    const byStatusRows = this.db.prepare("SELECT status, COUNT(*) AS c FROM work_item GROUP BY status").all();
    const byStatus = {};
    for (const row of byStatusRows) byStatus[row.status] = Number(row.c);
    const myOpen = Number(
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM work_item
              WHERE (owner_human_id = ? OR assignee_id = ?) AND status NOT IN ('completed','cancelled')`
      ).get(principal.memberId, principal.memberId).c
    );
    const approvals = this.db.prepare(
      `SELECT * FROM approval WHERE approver_id = ? AND status = 'pending'
          ORDER BY expires_at LIMIT 50`
    ).all(principal.memberId);
    const proposals = this.db.prepare(
      `SELECT * FROM proposal WHERE decider_id = ? AND status = 'open'
          ORDER BY created_at LIMIT 50`
    ).all(principal.memberId);
    const dueChecks = this.db.prepare(
      `SELECT c.*, w.title AS title FROM work_item_check c
           JOIN work_item w ON w.id = c.work_item_id
          WHERE c.status = 'scheduled' AND c.planned_due_at <= ?
            AND (w.owner_human_id = ? OR w.assignee_id = ?)
          ORDER BY c.planned_due_at LIMIT 50`
    ).all(at, principal.memberId, principal.memberId);
    const attention2 = this.db.prepare(
      `SELECT id, work_item_id AS workItemId, reason, detail, created_at AS createdAt
           FROM attention_item WHERE to_member_id = ? AND resolved_at IS NULL
          ORDER BY created_at DESC LIMIT 50`
    ).all(principal.memberId);
    const executions = this.db.prepare(
      `SELECT r.id AS runId, r.work_item_id AS workItemId, w.title AS title, r.status AS status,
                r.member_id AS memberId, r.started_at AS startedAt
           FROM task_run r JOIN work_item w ON w.id = r.work_item_id
          WHERE r.status IN ('queued','running')
            AND (w.owner_human_id = ? OR w.assignee_id = ?)
          ORDER BY r.created_at DESC LIMIT 50`
    ).all(principal.memberId, principal.memberId);
    const latestChangeSeq = Number(
      this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log").get().seq
    );
    return {
      principalId: principal.memberId,
      generatedAt: at,
      counts: {
        byStatus,
        myOpen,
        attention: attention2.length,
        activeRuns: Number(
          this.db.prepare("SELECT COUNT(*) AS c FROM task_run WHERE status IN ('queued','running')").get().c
        )
      },
      approvals,
      proposals,
      reviews: this.db.prepare("SELECT r.*, r.project_id AS projectId, p.name AS projectName FROM project_review r JOIN project p ON p.id=r.project_id WHERE r.status='awaiting_confirm' AND r.confirmer_id=? ORDER BY r.period_end DESC").all(principal.memberId),
      dueChecks,
      attention: attention2,
      executions,
      latestChangeSeq
    };
  }
  /**
   * 变更游标（画板 ㉑ 第 6 格）：只读 change_log；游标超出保留期返回 CURSOR_EXPIRED。
   * 保留期暂按「最早一条的 seq - 1」判断：有人归档/清理过旧行就算过期。
   */
  changesSince(ctx, input = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const cursor = Math.max(0, Math.floor(input.cursor ?? 0));
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const bounds = this.db.prepare("SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM change_log").get();
    const minSeq = bounds.minSeq === null ? 0 : Number(bounds.minSeq);
    const latestCursor = bounds.maxSeq === null ? 0 : Number(bounds.maxSeq);
    if (minSeq > 0 && cursor < minSeq - 1) {
      throw new HamsError("CURSOR_EXPIRED", `\u6E38\u6807 ${cursor} \u65E9\u4E8E\u4FDD\u7559\u671F\uFF08\u6700\u65E9 ${minSeq}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u62C9\u53D6\u5FEB\u7167`, {
        nextStep: "\u91CD\u65B0\u83B7\u53D6 overview/get \u5FEB\u7167\u540E\u518D\u7528\u65B0\u6E38\u6807\u589E\u91CF"
      });
    }
    const rows = this.db.prepare(
      `SELECT seq, object_kind AS objectKind, object_id AS objectId, revision,
                change_kind AS changeKind, created_at AS createdAt
           FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?`
    ).all(cursor, limit);
    const nextCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
    return {
      cursor,
      nextCursor,
      latestCursor,
      hasMore: nextCursor < latestCursor,
      items: rows.map((row) => ({ ...row, seq: Number(row.seq), revision: Number(row.revision) }))
    };
  }
  // ───────────────────────── 人工建单 ─────────────────────────
  createWorkItem(ctx, input) {
    return this.command(ctx, "workItem/create", input, () => {
      const principal = this.principal(ctx);
      let ownerHumanId = input.ownerHumanId ?? principal.memberId;
      let dedupeKey = input.dedupeKey ?? null;
      let templateVersionId = input.templateVersionId ?? null;
      if (principal.kind === "bot") {
        if (!input.projectId) {
          throw denied("bot \u5EFA\u5355\u5FC5\u987B\u6307\u5B9A\u9879\u76EE", "\u7528 hams_create_work_item \u5E76\u5E26\u4E0A projectId\uFF1B\u8DE8\u9879\u76EE\u5EFA\u5355\u5C5E\u4E8E\u8D8A\u6743");
        }
        const project = this.db.prepare("SELECT id, owner_human_id, coordinator_id, deleted_at FROM project WHERE id = ?").get(input.projectId);
        if (!project || project.deleted_at) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${input.projectId}`);
        if (project.coordinator_id !== principal.memberId) {
          requireCapability(principal, CAPABILITY.workItemCreate);
          const joined = this.db.prepare("SELECT 1 AS ok FROM project_participant WHERE project_id = ? AND member_id = ? AND removed_at IS NULL").get(project.id, principal.memberId);
          if (!joined) throw denied("\u53EA\u80FD\u7ED9\u81EA\u5DF1\u6240\u5728\u7684\u9879\u76EE\u5EFA\u5355", "\u5148\u8BA9\u9879\u76EE\u7BA1\u7406\u5458\u628A\u4F60\u62C9\u8FDB\u9879\u76EE\u56E2\u961F");
        }
        ownerHumanId = input.ownerHumanId ?? project.owner_human_id;
        if (!templateVersionId) {
          const prior = this.db.prepare("SELECT template_version_id FROM work_item WHERE project_id = ? AND template_version_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(project.id);
          templateVersionId = prior?.template_version_id ?? null;
        }
        dedupeKey = dedupeKey ?? `agent:${project.id}:${createHash9("sha256").update(String(input.title).trim()).digest("hex").slice(0, 16)}`;
      } else {
        requireCapability(principal, CAPABILITY.workItemCreate);
      }
      if (dedupeKey) {
        const open = this.findOpenByDedupeKey(dedupeKey);
        if (open) {
          const auditId2 = this.audit(ctx, principal, {
            action: "workItem/create",
            subjectKind: "work_item",
            subjectId: open.id,
            after: { duplicate: true, dedupeKey }
          });
          return this.receipt(ctx, {
            status: "accepted",
            objectId: open.id,
            objectRevision: open.revision,
            executionEpoch: open.execution_epoch,
            auditId: auditId2,
            detail: { duplicate: true, dedupeKey }
          });
        }
      }
      const item = this.createWorkItemTx(ctx, principal, {
        domain: input.domain,
        category: input.category,
        title: input.title,
        ownerHumanId,
        projectId: input.projectId ?? null,
        templateVersionId,
        assetId: input.assetId ?? null,
        dedupeKey,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        createdBy: principal.memberId
      });
      const auditId = this.audit(ctx, principal, {
        action: "workItem/create",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { title: item.title, dedupeKey: item.dedupe_key }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.execution_epoch,
        auditId,
        detail: { dedupeKey: item.dedupe_key }
      });
    });
  }
  // ───────────────────────── T1 建任务 ─────────────────────────
  ingestAlert(ctx, input) {
    return this.command(ctx, "work_item/ingestAlert", input, () => {
      const principal = this.principal(ctx);
      if (principal.kind !== "system") requireCapability(principal, CAPABILITY.connectorIngest);
      const at = this.now();
      const existingEvent = this.db.prepare("SELECT * FROM event_inbox WHERE connector = ? AND external_event_id = ?").get(input.connector, input.externalEventId);
      if (existingEvent) {
        const existingItem = existingEvent.work_item_id ? this.workItemOrThrow(existingEvent.work_item_id) : null;
        const auditId2 = this.audit(ctx, principal, {
          action: "work_item/ingestAlert",
          subjectKind: "event_inbox",
          subjectId: existingEvent.id,
          after: { disposition: existingEvent.disposition, duplicate: true }
        });
        return this.receipt(ctx, {
          status: "accepted",
          objectId: existingItem?.id,
          objectRevision: existingItem?.revision,
          executionEpoch: existingItem?.execution_epoch,
          auditId: auditId2,
          detail: { duplicate: true, disposition: existingEvent.disposition, eventId: existingEvent.id }
        });
      }
      const eventId = this.id();
      const assetId = this.upsertAsset(input.asset);
      this.db.prepare(
        `INSERT INTO event_inbox
             (id, connector, external_event_id, asset_id, event_type, severity, payload_ref, payload_hash,
              occurred_at, received_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`
      ).run(
        eventId,
        input.connector,
        input.externalEventId,
        assetId,
        input.eventType,
        input.severity ?? 0,
        input.payloadRef,
        input.payloadHash ?? createHash9("sha256").update(`${input.connector}:${input.externalEventId}`).digest("hex"),
        input.occurredAt,
        at
      );
      const open = this.findOpenByDedupeKey(input.workItem.dedupeKey);
      if (open) {
        this.db.prepare("UPDATE event_inbox SET work_item_id = ?, disposition = 'attached' WHERE id = ?").run(open.id, eventId);
        const auditId2 = this.audit(ctx, principal, {
          action: "work_item/ingestAlert",
          subjectKind: "work_item",
          subjectId: open.id,
          after: { disposition: "attached", eventId }
        });
        return this.receipt(ctx, {
          status: "accepted",
          objectId: open.id,
          objectRevision: open.revision,
          executionEpoch: open.execution_epoch,
          auditId: auditId2,
          detail: { duplicate: true, disposition: "attached", eventId }
        });
      }
      const item = this.createWorkItemTx(ctx, principal, {
        ...input.workItem,
        assetId,
        createdBy: principal.memberId
      });
      this.db.prepare("UPDATE event_inbox SET work_item_id = ?, disposition = 'created' WHERE id = ?").run(item.id, eventId);
      const auditId = this.audit(ctx, principal, {
        action: "work_item/ingestAlert",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { eventId, dedupeKey: input.workItem.dedupeKey }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.executionEpoch,
        auditId,
        detail: { eventId, disposition: "created" }
      });
    });
  }
  // ───────────────────────── T4 提议 → 采纳落单 ─────────────────────────
  propose(ctx, input) {
    return this.command(ctx, "proposal/propose", input, () => {
      const principal = this.principal(ctx);
      requireBot(principal);
      requireCapability(principal, CAPABILITY.proposalCreate);
      if (!Array.isArray(input.rationale?.evidence) || input.rationale.evidence.length === 0) {
        throw denied("\u63D0\u8BAE\u5FC5\u987B\u7ED9\u51FA\u7406\u7531\u4E0E\u8BC1\u636E\uFF1Brationale.evidence \u4E0D\u80FD\u4E3A\u7A7A");
      }
      const decider = this.memberOrThrow(input.deciderId);
      if (decider.kind !== "human") throw denied("\u63D0\u8BAE\u53EA\u80FD\u7531\u4EBA\u51B3\u5B9A\uFF1BdeciderId \u5FC5\u987B\u662F\u4EBA");
      const at = this.now();
      const open = this.db.prepare(
        `SELECT * FROM proposal WHERE subject_key = ? AND kind = ? AND dedupe_key = ? AND status = 'open'`
      ).get(input.subjectKey, input.kind, input.dedupeKey);
      if (open) {
        this.db.prepare("UPDATE proposal SET duplicate_count = duplicate_count + 1, revision = revision + 1 WHERE id = ?").run(open.id);
        writeChange(this.db, {
          objectKind: "proposal",
          objectId: open.id,
          revision: open.revision + 1,
          changeKind: "duplicate_proposal",
          at
        });
        const auditId2 = this.audit(ctx, principal, {
          action: "proposal/propose",
          subjectKind: "proposal",
          subjectId: open.id,
          after: { duplicate: true, duplicateCount: open.duplicate_count + 1 }
        });
        return this.receipt(ctx, {
          status: "accepted",
          objectId: open.id,
          auditId: auditId2,
          detail: { duplicate: true, duplicateCount: open.duplicate_count + 1 }
        });
      }
      const proposalId = this.id();
      this.db.prepare(
        `INSERT INTO proposal
             (id, subject_key, project_id, work_item_id, kind, dedupe_key, proposed_by, decider_id, title, body,
              rationale_json, impact_json, status, duplicate_count, snoozed_until, expires_at, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, NULL, ?, 1, ?)`
      ).run(
        proposalId,
        input.subjectKey,
        input.projectId ?? null,
        input.workItemId ?? null,
        input.kind,
        input.dedupeKey,
        principal.memberId,
        input.deciderId,
        input.title,
        input.body,
        JSON.stringify(input.rationale),
        JSON.stringify(input.impact ?? {}),
        input.expiresAt ?? null,
        at
      );
      writeChange(this.db, { objectKind: "proposal", objectId: proposalId, revision: 1, changeKind: "proposal_created", at });
      const auditId = this.audit(ctx, principal, {
        action: "proposal/propose",
        subjectKind: "proposal",
        subjectId: proposalId,
        after: { kind: input.kind, title: input.title }
      });
      return this.receipt(ctx, { status: "applied", objectId: proposalId, auditId });
    });
  }
  decideProposal(ctx, input) {
    return this.command(ctx, "proposal/decide", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.proposalDecide);
      if (ctx.channel !== "ui") throw denied("\u63D0\u8BAE\u53EA\u80FD\u7531\u4EBA\u901A\u8FC7UI\u51B3\u5B9A");
      const at = this.now();
      const proposal = this.db.prepare("SELECT * FROM proposal WHERE id = ?").get(input.proposalId);
      if (!proposal) throw stateInvalid(`\u63D0\u8BAE\u4E0D\u5B58\u5728\uFF1A${input.proposalId}`);
      if (proposal.status !== "open") throw stateInvalid(`\u63D0\u8BAE\u5DF2\u662F\u7EC8\u6001\uFF1A${proposal.status}`);
      if (proposal.decider_id !== principal.memberId) {
        throw denied("\u53EA\u6709\u63D0\u8BAE\u4E0A\u5199\u660E\u7684\u51B3\u5B9A\u4EBA\u53EF\u4EE5\u51B3\u5B9A");
      }
      if (input.decision === "reject" && input.note.trim().length === 0) {
        throw stateInvalid("\u9A73\u56DE\u5FC5\u987B\u5199\u660E\u539F\u56E0");
      }
      this.db.prepare(
        `INSERT INTO decision (id, proposal_id, decided_by, decision, channel, note, created_at)
           VALUES (?, ?, ?, ?, 'ui', ?, ?)`
      ).run(this.id(), proposal.id, principal.memberId, input.decision, input.note, at);
      let workItem = null;
      if (input.decision === "accept" && proposal.kind === "create_task") {
        if (!input.workItem) throw stateInvalid("\u91C7\u7EB3\u63D0\u8BAE\u5FC5\u987B\u7ED9\u51FA\u8981\u5EFA\u7684\u5DE5\u4F5C\u9879\u5185\u5BB9");
        const existing = this.findOpenByDedupeKey(proposal.dedupe_key);
        workItem = existing ?? this.createWorkItemTx(ctx, principal, {
          ...input.workItem,
          dedupeKey: proposal.dedupe_key,
          createdBy: principal.memberId
        });
        this.db.prepare(
          "UPDATE proposal SET status = 'accepted', result_work_item_id = ?, revision = revision + 1 WHERE id = ?"
        ).run(workItem.id, proposal.id);
      } else {
        if (input.workItem) throw stateInvalid("\u975E\u521B\u5EFA\u4EFB\u52A1\u63D0\u8BAE\u4E0D\u80FD\u9644\u5E26\u5EFA\u5355\u5185\u5BB9\uFF1B\u53D8\u66F4\u987B\u901A\u8FC7\u5BF9\u5E94\u53D7\u6743\u547D\u4EE4\u6267\u884C");
        this.db.prepare("UPDATE proposal SET status = ?, revision = revision + 1 WHERE id = ?").run(input.decision === "accept" ? "accepted" : "rejected", proposal.id);
      }
      writeChange(this.db, {
        objectKind: "proposal",
        objectId: proposal.id,
        revision: proposal.revision + 1,
        changeKind: `proposal_${input.decision === "accept" ? "accepted" : "rejected"}`,
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "proposal/decide",
        subjectKind: "proposal",
        subjectId: proposal.id,
        after: { decision: input.decision, note: input.note, workItemId: workItem?.id ?? null }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: workItem?.id ?? proposal.id,
        objectRevision: workItem?.revision,
        executionEpoch: workItem?.execution_epoch,
        auditId,
        detail: { proposalId: proposal.id, decision: input.decision, workItemId: workItem?.id ?? null }
      });
    });
  }
  // ───────────────────────── T2 认领 ─────────────────────────
  claim(ctx, input) {
    return this.command(ctx, "work_item/claim", input, () => {
      const principal = this.principal(ctx);
      requireBot(principal);
      if (ctx.channel === "system") {
        const canClaim = principal.capabilities instanceof Set ? principal.capabilities.has(CAPABILITY.workItemClaim) : false;
        if (!canClaim) requireCapability(principal, CAPABILITY.workItemExecute);
      } else {
        requireCapability(principal, CAPABILITY.workItemClaim);
      }
      const at = this.now();
      const before = this.workItemOrThrow(input.workItemId);
      if (before.status !== "ready") {
        throw stateInvalid(`\u53EA\u6709 ready \u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u8BA4\u9886\uFF0C\u5F53\u524D ${before.status}`, "\u5237\u65B0\u540E\u91CD\u8BD5");
      }
      const leaseMinutes = Math.min(Math.max(input.leaseMinutes ?? 10, 1), 120);
      const updated = this.db.prepare(
        `UPDATE work_item
              SET status = 'active', assignee_id = ?, revision = revision + 1,
                  execution_epoch = execution_epoch + 1, fence_seq = fence_seq + 1, updated_at = ?
            WHERE id = ? AND status = 'ready'`
      ).run(principal.memberId, at, input.workItemId);
      if (updated.changes !== 1) throw stateInvalid("\u8BA4\u9886\u7ADE\u4E89\u5931\u8D25\uFF1A\u5DE5\u4F5C\u9879\u72B6\u6001\u5DF2\u53D8\u5316");
      const current = this.workItemOrThrow(input.workItemId);
      const thread = this.ensureThreadTx(principal, current, input.sessionId);
      const runId = this.id();
      this.db.prepare(
        `INSERT INTO task_run
             (id, work_item_id, thread_id, check_id, member_id, member_version, skill_versions_json,
              execution_epoch, runtime_epoch, fence, trigger, attempt, status, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, '{}', ?, ?, ?, 'claim', 1, 'queued', ?)`
      ).run(
        runId,
        current.id,
        thread.id,
        principal.memberId,
        thread.member_version,
        current.execution_epoch,
        this.runtimeEpoch,
        current.fence_seq,
        at
      );
      const leaseUntil = at + leaseMinutes * 6e4;
      this.db.prepare(
        `INSERT INTO lease (work_item_id, holder_member_id, run_id, fence, runtime_epoch, lease_until, renewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(current.id, principal.memberId, runId, current.fence_seq, this.runtimeEpoch, leaseUntil, at);
      writeEvent(this.db, this.id(), {
        workItemId: current.id,
        kind: "work_item_claimed",
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { runId, threadId: thread.id, fence: current.fence_seq, executionEpoch: current.execution_epoch },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: current.id, revision: current.revision, changeKind: "claimed", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/claim",
        subjectKind: "work_item",
        subjectId: current.id,
        before: { status: before.status, assignee: before.assignee_id },
        after: { status: "active", assignee: principal.memberId, runId, executionEpoch: current.execution_epoch }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: current.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { runId, threadId: thread.id, leaseUntil, fence: current.fence_seq }
      });
    });
  }
  /**
   * 指派：把一个 ready 的工作项交给某个在岗 bot（或人）。
   * 人要有 work_item.manage；bot 只能是该工作项所属项目的推进 bot（coordinator）——
   * 这就是「协调 bot 派活」的入口。真正开跑由会话适配器的派发器完成：它替被指派 bot 认领并投递一轮。
   */
  assignWorkItem(ctx, input) {
    return this.command(ctx, "work_item/assign", input, () => {
      const principal = this.principal(ctx);
      const at = this.now();
      const before = this.workItemOrThrow(input.workItemId);
      const target = this.db.prepare("SELECT id, kind, name, status FROM member WHERE id = ?").get(input.memberId);
      if (!target) throw stateInvalid(`\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${input.memberId}`);
      if (target.status !== "active") throw stateInvalid(`${target.name} \u4E0D\u5728\u5C97\uFF0C\u4E0D\u80FD\u63A5\u4EFB\u52A1`);
      let allowed = false;
      if (principal.kind === "human") {
        requireCapability(principal, CAPABILITY.workItemManage);
        allowed = true;
      } else {
        const coordinator = before.project_id ? this.db.prepare("SELECT coordinator_id FROM project WHERE id = ?").get(before.project_id)?.coordinator_id : null;
        allowed = Boolean(coordinator && coordinator === principal.memberId);
      }
      if (!allowed) throw denied("\u53EA\u6709\u9879\u76EE\u7684\u63A8\u8FDB bot \u6216\u5177\u5907\u5DE5\u5355\u7BA1\u7406\u6743\u9650\u7684\u4EBA\u53EF\u4EE5\u6307\u6D3E\u4EFB\u52A1");
      if (before.status !== "ready") throw stateInvalid(`\u53EA\u6709\u5F85\u5904\u7406\u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u6307\u6D3E\uFF0C\u5F53\u524D ${before.status}`);
      if (before.assignee_id === input.memberId) {
        return this.receipt(ctx, { status: "noop", objectId: before.id, objectRevision: before.revision, executionEpoch: before.execution_epoch, detail: { memberId: target.id, alreadyAssigned: true } });
      }
      this.db.prepare("UPDATE work_item SET assignee_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(target.id, at, before.id);
      const after = this.workItemOrThrow(before.id);
      writeEvent(this.db, this.id(), {
        workItemId: after.id,
        kind: "work_item_assigned",
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { memberId: target.id, memberName: target.name, previous: before.assignee_id },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: after.id, revision: after.revision, changeKind: "assigned", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/assign",
        subjectKind: "work_item",
        subjectId: after.id,
        before: { assignee: before.assignee_id },
        after: { assignee: target.id, revision: after.revision }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: after.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
        detail: { memberId: target.id, memberName: target.name }
      });
    });
  }
  accept(ctx, input) {
    return this.command(ctx, "work_item/accept", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.workItemAccept);
      const at = this.now();
      const before = this.workItemOrThrow(input.workItemId);
      if (before.status !== "ready") throw stateInvalid(`\u53EA\u6709 ready \u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u63A5\u5355\uFF0C\u5F53\u524D ${before.status}`);
      this.db.prepare(
        `UPDATE work_item
              SET status = 'active', assignee_id = ?, revision = revision + 1,
                  execution_epoch = execution_epoch + 1, updated_at = ?
            WHERE id = ? AND status = 'ready'`
      ).run(principal.memberId, at, input.workItemId);
      const current = this.workItemOrThrow(input.workItemId);
      writeEvent(this.db, this.id(), {
        workItemId: current.id,
        kind: "work_item_accepted",
        actorId: principal.memberId,
        actorKind: "human",
        payload: { note: input.note ?? "" },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: current.id, revision: current.revision, changeKind: "accepted", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/accept",
        subjectKind: "work_item",
        subjectId: current.id,
        before: { status: before.status },
        after: { status: "active", assignee: principal.memberId, executionEpoch: current.execution_epoch }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: current.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId
      });
    });
  }
  // ───────────────────────── T3 运行开始 / 结束 ─────────────────────────
  rotateThread(ctx, input) {
    return this.command(ctx, "work_item/rotateThread", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.workItemManage);
      if (ctx.channel !== "ui") throw denied("\u624B\u52A8\u6362\u65B0\u4F1A\u8BDD\u53EA\u80FD\u7531\u4EBA\u901A\u8FC7UI\u6267\u884C");
      const item = this.workItemOrThrow(input.workItemId), at = this.now();
      if (TERMINAL_ITEM_STATUSES.includes(item.status)) throw stateInvalid("\u7EC8\u6001\u5DE5\u4F5C\u9879\u4E0D\u80FD\u6362\u65B0\u4F1A\u8BDD");
      if (this.db.prepare("SELECT id FROM task_run WHERE work_item_id=? AND status='running'").get(item.id)) throw stateInvalid("\u8FD0\u884C\u4E2D\u4E0D\u80FD\u6362\u65B0\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u7B49\u672C\u8F6E\u7ED3\u675F");
      if (!item.assignee_id) throw stateInvalid("\u5DE5\u4F5C\u9879\u5C1A\u672A\u5206\u914Dbot");
      const bot = resolvePrincipal(this.db, item.assignee_id, at);
      requireBot(bot);
      if (typeof input.sessionId !== "string" || !input.sessionId.trim()) throw stateInvalid("\u65B0\u5BBF\u4E3B\u4F1A\u8BDDid\u4E0D\u80FD\u4E3A\u7A7A");
      if (this.db.prepare("SELECT id FROM work_item_thread WHERE session_id=?").get(input.sessionId)) throw stateInvalid("\u65B0\u4F1A\u8BDDid\u5DF2\u7ED1\u5B9A\uFF0C\u4E0D\u80FD\u590D\u7528\u65E7\u4F1A\u8BDD");
      this.closeThreadTx(item.id, input.reason ?? "manual_rotation", at);
      const thread = this.ensureThreadTx(bot, item, input.sessionId);
      const rewired = this.db.prepare("UPDATE task_run SET thread_id=?,member_version=? WHERE work_item_id=? AND status='queued'").run(thread.id, thread.member_version, item.id);
      this.db.prepare("UPDATE work_item SET revision=revision+1,updated_at=? WHERE id=?").run(at, item.id);
      const after = this.workItemOrThrow(item.id), detail = { threadId: thread.id, generation: thread.generation, memberVersion: thread.member_version, sessionId: thread.session_id, rewiredRuns: Number(rewired.changes) };
      writeEvent(this.db, this.id(), { workItemId: item.id, kind: "thread_rotated", actorId: principal.memberId, actorKind: "human", payload: { ...detail, reason: input.reason ?? "manual_rotation" }, revision: after.revision, executionEpoch: after.execution_epoch, at });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: after.revision, changeKind: "thread_rotated", at });
      const auditId = this.audit(ctx, principal, { action: "work_item/rotateThread", subjectKind: "work_item", subjectId: item.id, after: detail });
      return this.receipt(ctx, { status: "applied", objectId: item.id, objectRevision: after.revision, executionEpoch: after.execution_epoch, auditId, detail });
    });
  }
  startRun(ctx, input) {
    return this.command(ctx, "run/start", input, () => {
      const principal = this.principal(ctx);
      requireBot(principal);
      requireCapability(principal, CAPABILITY.workItemExecute);
      const at = this.now();
      const run = this.runOrThrow(input.runId);
      if (run.member_id !== principal.memberId) throw denied("\u53EA\u80FD\u542F\u52A8\u81EA\u5DF1\u7684\u8FD0\u884C");
      if (run.status !== "queued") throw stateInvalid(`\u8FD0\u884C\u72B6\u6001\u4E0D\u662F queued\uFF1A${run.status}`);
      const major = this.db.prepare("SELECT version FROM member_version WHERE member_id=? AND version>? AND change_class='major' ORDER BY version DESC LIMIT 1").get(principal.memberId, run.member_version);
      const boundThread = this.db.prepare("SELECT status FROM work_item_thread WHERE id=?").get(run.thread_id);
      if (major || boundThread?.status === "pending_rotate") {
        const item2 = this.workItemOrThrow(run.work_item_id);
        const thread = this.ensureThreadTx(principal, item2, input.sessionId);
        this.db.prepare("UPDATE task_run SET thread_id=?,member_version=? WHERE id=?").run(thread.id, thread.member_version, run.id);
        run.thread_id = thread.id;
        run.member_version = thread.member_version;
      }
      const item = this.workItemOrThrow(run.work_item_id);
      if (item.execution_epoch !== run.execution_epoch) {
        throw new HamsError("EPOCH_STALE", "\u5DE5\u4F5C\u9879\u6267\u884C\u4EE3\u6B21\u5DF2\u53D8\uFF0C\u8FD9\u6B21\u8FD0\u884C\u4F5C\u5E9F", { nextStep: "\u91CD\u65B0\u8BA4\u9886" });
      }
      const busy = this.db.prepare("SELECT COUNT(*) AS c FROM task_run WHERE member_id = ? AND status = 'running'").get(principal.memberId);
      if (Number(busy.c) > 0) throw stateInvalid("\u8BE5 bot \u5DF2\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF1B\u540C\u4E00 agent \u540C\u65F6\u53EA\u8DD1 1 \u4E2A\u4EFB\u52A1");
      this.db.prepare("UPDATE task_run SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(at, run.id);
      this.db.prepare("UPDATE work_item_thread SET turn_count = turn_count + 1 WHERE id = ?").run(run.thread_id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "run_started",
        actorId: principal.memberId,
        actorKind: "bot",
        payload: { runId: run.id, threadId: run.thread_id },
        revision: item.revision,
        executionEpoch: item.execution_epoch,
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "run/start",
        subjectKind: "task_run",
        subjectId: run.id,
        before: { status: "queued" },
        after: { status: "running" }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.execution_epoch,
        auditId,
        detail: { runId: run.id }
      });
    });
  }
  submitResult(ctx, input) {
    return this.command(ctx, "run/submitResult", input, () => {
      const principal = this.principal(ctx);
      requireBot(principal);
      requireCapability(principal, CAPABILITY.workItemExecute);
      const at = this.now();
      const run = this.runOrThrow(input.runId);
      if (run.member_id !== principal.memberId) throw denied("\u53EA\u80FD\u63D0\u4EA4\u81EA\u5DF1\u7684\u8FD0\u884C\u7ED3\u679C");
      if (run.status !== "running") throw stateInvalid(`\u8FD0\u884C\u72B6\u6001\u4E0D\u662F running\uFF1A${run.status}`);
      const item = this.workItemOrThrow(run.work_item_id);
      if (item.execution_epoch !== run.execution_epoch) {
        throw new HamsError("EPOCH_STALE", "\u8FD0\u884C\u6240\u5C5E\u4EE3\u6B21\u5DF2\u8FC7\u671F", { nextStep: "\u4E22\u5F03\u8FD9\u6B21\u7ED3\u679C\uFF0C\u7B49\u65B0\u8FD0\u884C" });
      }
      if (item.status !== "active") {
        if (item.status === "waiting_check" && run.check_id) {
          this.db.prepare("UPDATE task_run SET status = 'succeeded', finished_at = ?, result_summary = ? WHERE id = ? AND status = 'running'").run(at, input.summary, run.id);
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: "check_run_finished",
            actorId: principal.memberId,
            actorKind: "bot",
            payload: { runId: run.id, checkId: run.check_id, summary: input.summary },
            revision: item.revision,
            executionEpoch: item.execution_epoch,
            at
          });
          const auditId2 = this.audit(ctx, principal, {
            action: "run/submitResult",
            subjectKind: "task_run",
            subjectId: run.id,
            before: { status: "running" },
            after: { status: "succeeded", checkId: run.check_id }
          });
          return this.receipt(ctx, {
            status: "applied",
            objectId: item.id,
            objectRevision: item.revision,
            executionEpoch: item.execution_epoch,
            auditId: auditId2,
            detail: { runId: run.id, checkId: run.check_id, checkOnly: true }
          });
        }
        throw stateInvalid(`\u53EA\u6709 active \u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u63D0\u4EA4\u7ED3\u679C\uFF0C\u5F53\u524D ${item.status}`);
      }
      this.db.prepare("UPDATE task_run SET status = 'succeeded', finished_at = ?, result_summary = ? WHERE id = ? AND status = 'running'").run(at, input.summary, run.id);
      const template = this.templateVersionTx(item.template_version_id);
      const checkPolicy = parseCheckPolicy(template?.check_policy_json);
      const plannedDueAt = nextCheckAt(checkPolicy, at);
      const generation = item.check_generation + 1;
      const checkId = this.id();
      this.db.prepare(
        `INSERT INTO work_item_check
             (id, work_item_id, generation, execution_epoch, template_version_id, planned_due_at, status,
              evidence_set_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, '{}', ?)`
      ).run(checkId, item.id, generation, item.execution_epoch, item.template_version_id, plannedDueAt, item.evidence_set_hash, at);
      this.db.prepare(
        `UPDATE work_item
              SET status = 'waiting_check', revision = revision + 1, check_generation = ?, next_action_at = ?, updated_at = ?
            WHERE id = ?`
      ).run(generation, plannedDueAt, at, item.id);
      const current = this.workItemOrThrow(item.id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "result_submitted",
        actorId: principal.memberId,
        actorKind: "bot",
        payload: { runId: run.id, summary: input.summary, checkId, plannedDueAt },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: current.revision, changeKind: "result_submitted", at });
      writeChange(this.db, { objectKind: "work_item_check", objectId: checkId, revision: 1, changeKind: "check_scheduled", at });
      const auditId = this.audit(ctx, principal, {
        action: "run/submitResult",
        subjectKind: "task_run",
        subjectId: run.id,
        before: { status: "running" },
        after: { status: "succeeded", checkId, plannedDueAt }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { runId: run.id, checkId, plannedDueAt }
      });
    });
  }
  // ───────────────────────── T8 追加证据 ─────────────────────────
  appendEvidence(ctx, input) {
    return this.command(ctx, "work_item/addEvidence", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.evidenceAppend);
      const at = this.now();
      const item = this.workItemOrThrow(input.workItemId);
      if (item.status === "cancelled") throw stateInvalid("\u5DF2\u53D6\u6D88\u7684\u5DE5\u4F5C\u9879\u4E0D\u80FD\u518D\u8FFD\u52A0\u8BC1\u636E");
      if (input.supersedesId) {
        const old = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(input.supersedesId);
        if (!old || old.work_item_id !== item.id) throw stateInvalid("\u88AB\u66FF\u4EE3\u7684\u8BC1\u636E\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u8BE5\u5DE5\u4F5C\u9879");
        if (old.status !== "active") throw stateInvalid(`\u88AB\u66FF\u4EE3\u7684\u8BC1\u636E\u72B6\u6001\u4E0D\u662F active\uFF1A${old.status}`);
        this.db.prepare("UPDATE evidence SET status = 'superseded' WHERE id = ?").run(old.id);
      }
      const evidenceId = this.id();
      const contentHash = input.contentHash ?? createHash9("sha256").update(`${input.kind}\0${input.ref}`).digest("hex");
      this.db.prepare(
        `INSERT INTO evidence
             (id, work_item_id, run_id, kind, ref, content_hash, source, observed_at, captured_at, captured_by,
              on_behalf_of, supersedes_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      ).run(
        evidenceId,
        item.id,
        input.runId ?? null,
        input.kind,
        input.ref,
        contentHash,
        input.source ?? "",
        input.observedAt,
        at,
        principal.memberId,
        input.onBehalfOf ?? null,
        input.supersedesId ?? null
      );
      const newHash = evidenceSetHash(this.evidenceSnapshots(item.id));
      this.db.prepare("UPDATE work_item SET evidence_set_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(newHash, at, item.id);
      const current = this.workItemOrThrow(item.id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "evidence_appended",
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { evidenceId, kind: input.kind, evidenceSetHash: newHash, supersedesId: input.supersedesId ?? null },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: current.revision, changeKind: "evidence_appended", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/addEvidence",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { evidenceId, evidenceSetHash: newHash }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { evidenceId, evidenceSetHash: newHash }
      });
    });
  }
  // ───────────────────────── T6 审批请求 ─────────────────────────
  requestClosure(ctx, input) {
    return this.command(ctx, "work_item/requestClosure", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.workItemRequestClosure);
      const at = this.now();
      const item = this.workItemOrThrow(input.workItemId);
      if (!["active", "waiting_check", "blocked", "waiting_review"].includes(item.status)) {
        throw stateInvalid(`\u5F53\u524D\u72B6\u6001\u4E0D\u80FD\u7533\u8BF7\u5173\u5355\uFF1A${item.status}`);
      }
      const template = this.templateVersionTx(item.template_version_id);
      if (!template) {
        throw evidenceIncomplete("\u5DE5\u4F5C\u9879\u6CA1\u6709\u7ED1\u5B9A\u6A21\u677F\u7248\u672C\uFF0C\u65E0\u6CD5\u6821\u9A8C\u5173\u5355\u5224\u636E");
      }
      if (template.status !== "published") throw stateInvalid(`\u5224\u636E\u7248\u672C\u672A\u53D1\u5E03\uFF1A${template.status}`);
      const requirements = parseEvidenceRequirements(template.required_evidence_json);
      const snapshot = buildCriteriaSnapshot(template.id, requirements, this.evidenceSnapshots(item.id), at);
      if (!snapshot.result.satisfied) {
        throw evidenceIncomplete("\u8BC1\u636E\u6E05\u5355\u672A\u6EE1\u8DB3\uFF0C\u4E0D\u80FD\u7533\u8BF7\u5173\u5355", snapshot.result.missing);
      }
      if (template.validator_key) {
        const validator = this.validators[template.validator_key];
        if (!validator) {
          throw new HamsError(
            "HOST_CAPABILITY_MISSING",
            `\u5224\u636E\u9A8C\u8BC1\u5668\u672A\u6CE8\u518C\uFF1A${template.validator_key}`,
            { nextStep: "\u6CE8\u518C\u8BE5\u9A8C\u8BC1\u5668\u540E\u518D\u7533\u8BF7\u5173\u5355\uFF0C\u6216\u964D\u7EA7\u4E3A\u4EBA\u5DE5\u5224\u5B9A" }
          );
        }
        const result = validator({
          workItem: item,
          evidence: this.evidenceRows(item.id),
          params: this.parseJsonObject(template.validator_params_json),
          now: at
        });
        if (!result.passed) {
          throw evidenceIncomplete(`\u5224\u636E\u9A8C\u8BC1\u5668 ${template.validator_key} \u672A\u901A\u8FC7`, result.detail ?? null);
        }
      }
      const pending2 = this.db.prepare(
        `SELECT id FROM approval WHERE subject_kind = 'work_item_close' AND subject_id = ? AND status = 'pending'`
      ).get(item.id);
      if (pending2) throw stateInvalid("\u8BE5\u5DE5\u4F5C\u9879\u5DF2\u6709\u4E00\u6761\u5F85\u51B3\u5BA1\u6279", "\u7B49\u73B0\u6709\u5BA1\u6279\u7ED3\u675F\u6216\u5931\u6548\u540E\u518D\u7533\u8BF7");
      if (item.status === "waiting_review") {
        this.db.prepare("UPDATE work_item SET revision = revision + 1, updated_at = ? WHERE id = ?").run(at, item.id);
      } else {
        this.db.prepare(
          `UPDATE work_item
                SET status = 'waiting_review', resume_state = NULL, blocked_reason = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE id = ?`
        ).run(at, item.id);
      }
      const current = this.workItemOrThrow(item.id);
      const reviewPolicy = parseReviewPolicy(template.review_policy_json);
      const approverId = this.resolveApproverTx(reviewPolicy, current, at);
      const approvalId = this.id();
      const expiresAt = at + reviewPolicy.expiresHours * 36e5;
      this.db.prepare(
        `INSERT INTO approval
             (id, subject_kind, subject_id, subject_revision, execution_epoch, evidence_set_hash, criteria_ref,
              criteria_json, reason_text, requested_by, requested_channel, approver_id, status,
              decision_note, expires_at, created_at)
           VALUES (?, 'work_item_close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`
      ).run(
        approvalId,
        item.id,
        current.revision,
        current.execution_epoch,
        current.evidence_set_hash,
        template.id,
        JSON.stringify(snapshot),
        input.reason,
        principal.memberId,
        this.requestChannel(ctx),
        approverId,
        expiresAt,
        at
      );
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "closure_requested",
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { approvalId, approverId, expiresAt, evidenceSetHash: current.evidence_set_hash },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "approval", objectId: approvalId, revision: 1, changeKind: "approval_requested", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/requestClosure",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { approvalId, approverId, expiresAt }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        approvalId,
        auditId,
        detail: { approvalId, approverId, expiresAt, criteria: snapshot }
      });
    });
  }
  // ───────────────────────── T7 / T5 审批决定与关单 ─────────────────────────
  decideApproval(ctx, input) {
    return this.command(ctx, "approval/decide", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.approvalDecide);
      const at = this.now();
      const approval = this.approvalOrThrow(input.approvalId);
      if (approval.status !== "pending") throw stateInvalid(`\u5BA1\u6279\u5DF2\u662F\u7EC8\u6001\uFF1A${approval.status}`);
      if (approval.approver_id !== principal.memberId) {
        throw new HamsError("NOT_APPROVER", "\u53EA\u6709\u7533\u8BF7\u65F6\u6307\u5B9A\u7684\u5BA1\u6279\u4EBA\u53EF\u4EE5\u51B3\u5B9A", { nextStep: "\u8BA9\u6307\u5B9A\u5BA1\u6279\u4EBA\u5904\u7406" });
      }
      if (at >= approval.expires_at) {
        throw new HamsError("APPROVAL_EXPIRED", "\u5BA1\u6279\u5DF2\u8FC7\u6709\u6548\u671F", { nextStep: "\u91CD\u65B0\u7533\u8BF7" });
      }
      if (input.decision !== "approve" && input.decision !== "reject" && input.decision !== "return") {
        throw stateInvalid(`\u672A\u77E5\u5BA1\u6279\u51B3\u5B9A\uFF1A${String(input.decision)}`);
      }
      const note = input.note ?? "";
      if ((input.decision === "reject" || input.decision === "return") && note.trim().length === 0) {
        throw stateInvalid("\u9A73\u56DE\u6216\u9000\u56DE\u5FC5\u987B\u5199\u660E\u539F\u56E0");
      }
      const isCloseSubject = approval.subject_kind === "work_item_close";
      const isTargetCheck = approval.subject_kind === "target_change";
      let targetCheck = null;
      if (isTargetCheck) {
        targetCheck = this.db.prepare("SELECT id,target_id,status,submitted_by,approver_id FROM project_phase_target_check WHERE id = ?").get(approval.subject_id) ?? null;
        if (!targetCheck) throw stateInvalid("\u68C0\u9A8C\u8BB0\u5F55\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664");
        if (targetCheck.status !== "pending") throw stateInvalid(`\u8FD9\u6761\u68C0\u9A8C\u5DF2\u5904\u7406\uFF1A${targetCheck.status}`);
      }
      let item = null;
      if (isCloseSubject) {
        item = this.workItemOrThrow(approval.subject_id);
        if (item.status !== "waiting_review") throw stateInvalid(`\u5DE5\u4F5C\u9879\u4E0D\u5728\u5F85\u9A8C\u6536\u72B6\u6001\uFF1A${item.status}`);
        if (item.evidence_set_hash !== approval.evidence_set_hash) {
          throw new HamsError("EVIDENCE_CHANGED", "\u8BC1\u636E\u6750\u6599\u5DF2\u53D8\uFF0C\u8FD9\u6B21\u5BA1\u6279\u7684\u5BF9\u8C61\u4E0D\u518D\u662F\u6700\u65B0\u7248\u672C", {
            nextStep: "\u6309\u65B0\u6750\u6599\u91CD\u65B0\u7533\u8BF7"
          });
        }
        if (item.revision !== approval.subject_revision) {
          throw new HamsError("VERSION_CONFLICT", "\u5BF9\u8C61\u4FEE\u8BA2\u53F7\u5DF2\u53D8\uFF0C\u5BA1\u6279\u4F5C\u5E9F", { nextStep: "\u5237\u65B0\u540E\u91CD\u65B0\u7533\u8BF7" });
        }
        if (item.execution_epoch !== approval.execution_epoch) {
          throw new HamsError("EPOCH_STALE", "\u6267\u884C\u4EE3\u6B21\u5DF2\u53D8\uFF0C\u8FD9\u6B21\u5BA1\u6279\u4E0D\u9002\u7528", { nextStep: "\u5728\u65B0\u4EE3\u6B21\u4E0A\u91CD\u65B0\u5904\u7F6E" });
        }
      }
      const status = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "returned";
      this.db.prepare(
        `UPDATE approval
              SET status = ?, decided_by = ?, decided_channel = 'ui', decision_note = ?, decided_at = ?
            WHERE id = ? AND status = 'pending'`
      ).run(status, principal.memberId, note, at, approval.id);
      if (isTargetCheck && targetCheck) {
        const nextStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "pending";
        this.db.prepare("UPDATE project_phase_target_check SET status = ?, result = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(nextStatus, input.decision === "approve" ? "met" : input.decision === "reject" ? "missed" : "unknown", principal.memberId, at, note, targetCheck.id);
      }
      let itemAfter = null;
      if (isCloseSubject && item) {
        if (input.decision === "approve") {
          this.db.prepare(
            `UPDATE work_item
                  SET status = 'completed', revision = revision + 1, updated_at = ?, completed_at = ?
                WHERE id = ? AND status = 'waiting_review'`
          ).run(at, at, item.id);
          this.closeThreadTx(item.id, "completed", at);
          this.db.prepare("DELETE FROM lease WHERE work_item_id = ?").run(item.id);
          itemAfter = this.workItemOrThrow(item.id);
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: "work_item_closed",
            actorId: principal.memberId,
            actorKind: "human",
            payload: { approvalId: approval.id, evidenceSetHash: item.evidence_set_hash },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at
          });
          writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "closed", at });
        } else if (input.decision === "reject") {
          this.db.prepare("UPDATE work_item SET status = 'active', revision = revision + 1, updated_at = ? WHERE id = ?").run(at, item.id);
          itemAfter = this.workItemOrThrow(item.id);
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: "closure_rejected",
            actorId: principal.memberId,
            actorKind: "human",
            payload: { approvalId: approval.id, note },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at
          });
          writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "closure_rejected", at });
        } else {
          this.db.prepare(
            `UPDATE work_item
                  SET status = 'blocked', blocked_reason = 'needs_evidence', revision = revision + 1, updated_at = ?
                WHERE id = ?`
          ).run(at, item.id);
          itemAfter = this.workItemOrThrow(item.id);
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: "closure_returned",
            actorId: principal.memberId,
            actorKind: "human",
            payload: { approvalId: approval.id, note },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at
          });
          writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "closure_returned", at });
        }
      }
      writeChange(this.db, { objectKind: "approval", objectId: approval.id, revision: 1, changeKind: `approval_${status}`, at });
      const auditId = this.audit(ctx, principal, {
        action: "approval/decide",
        subjectKind: "approval",
        subjectId: approval.id,
        before: { status: "pending" },
        after: { status, note, workItemStatus: itemAfter?.status ?? null }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: itemAfter?.id ?? approval.subject_id,
        objectRevision: itemAfter?.revision,
        executionEpoch: itemAfter?.execution_epoch,
        approvalId: approval.id,
        auditId,
        detail: { approvalStatus: status, workItemStatus: itemAfter?.status ?? null }
      });
    });
  }
  // ───────────────────────── 复查判定 ─────────────────────────
  evaluateCheck(ctx, input) {
    return this.command(ctx, "check/evaluate", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.checkEvaluate);
      const at = this.now();
      const check = this.checkOrThrow(input.checkId);
      if (!["scheduled", "running"].includes(check.status)) {
        throw stateInvalid(`\u590D\u67E5\u5DF2\u662F\u7EC8\u6001\uFF1A${check.status}`);
      }
      const item = this.workItemOrThrow(check.work_item_id);
      if (item.execution_epoch !== check.execution_epoch) {
        throw new HamsError("EPOCH_STALE", "\u590D\u67E5\u6240\u5C5E\u4EE3\u6B21\u5DF2\u8FC7\u671F", { nextStep: "\u6309\u5F53\u524D\u4EE3\u6B21\u91CD\u65B0\u6392\u590D\u67E5" });
      }
      const template = this.templateVersionTx(check.template_version_id ?? item.template_version_id);
      const requirements = parseEvidenceRequirements(template?.required_evidence_json);
      const rows = this.evidenceRows(item.id);
      const snapshot = buildCriteriaSnapshot(
        template?.id ?? item.template_version_id,
        requirements,
        this.evidenceSnapshots(item.id),
        at
      );
      let validatorResult = null;
      let validatorPassed = true;
      if (template?.validator_key) {
        const validator = this.validators[template.validator_key];
        if (!validator) {
          throw new HamsError("HOST_CAPABILITY_MISSING", `\u5224\u636E\u9A8C\u8BC1\u5668\u672A\u6CE8\u518C\uFF1A${template.validator_key}`);
        }
        const result = validator({
          workItem: item,
          evidence: rows,
          params: this.parseJsonObject(template.validator_params_json),
          now: at
        });
        validatorPassed = result.passed;
        validatorResult = result.detail ?? null;
      }
      const freshHash = evidenceSetHash(this.evidenceSnapshots(item.id));
      let verdict;
      if (!snapshot.result.satisfied) {
        const allKindsEmpty = snapshot.result.missing.every((missing) => missing.have === 0);
        verdict = allKindsEmpty ? "unknown" : "failed";
      } else {
        verdict = validatorPassed ? "passed" : "failed";
      }
      this.db.prepare(
        `UPDATE work_item_check
              SET status = ?, evidence_set_hash = ?, result_json = ?, evaluated_at = ?
            WHERE id = ?`
      ).run(
        verdict,
        freshHash,
        JSON.stringify({ criteria: snapshot, validator: validatorResult, verdict }),
        at,
        check.id
      );
      let itemAfter = item;
      let autoClosed = false;
      if (verdict === "passed" && item.status === "waiting_check" && item.close_requires_approval === 0) {
        this.db.prepare(
          "UPDATE work_item SET status = 'waiting_review', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'waiting_check'"
        ).run(at, item.id);
        this.db.prepare(
          `UPDATE work_item
                SET status = 'completed', revision = revision + 1, updated_at = ?, completed_at = ?
              WHERE id = ?`
        ).run(at, at, item.id);
        this.closeThreadTx(item.id, "completed", at);
        this.db.prepare("DELETE FROM lease WHERE work_item_id = ?").run(item.id);
        itemAfter = this.workItemOrThrow(item.id);
        autoClosed = true;
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: "work_item_auto_closed",
          actorId: "system",
          actorKind: "system",
          payload: { checkId: check.id, evidenceSetHash: freshHash },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at
        });
        writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "auto_closed", at });
      } else if (verdict === "failed" && item.status === "waiting_check") {
        this.db.prepare("UPDATE work_item SET status = 'active', revision = revision + 1, next_action_at = NULL, updated_at = ? WHERE id = ?").run(at, item.id);
        itemAfter = this.workItemOrThrow(item.id);
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: "check_failed",
          actorId: principal.memberId,
          actorKind: principal.kind,
          payload: { checkId: check.id },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at
        });
        writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "check_failed", at });
      } else if (verdict === "unknown" && item.status === "waiting_check") {
        this.db.prepare(
          `UPDATE work_item
                SET status = 'blocked', blocked_reason = 'data_source', revision = revision + 1, updated_at = ?
              WHERE id = ?`
        ).run(at, item.id);
        itemAfter = this.workItemOrThrow(item.id);
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: "check_unknown",
          actorId: principal.memberId,
          actorKind: principal.kind,
          payload: { checkId: check.id },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at
        });
        writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: itemAfter.revision, changeKind: "check_unknown", at });
      }
      writeChange(this.db, { objectKind: "work_item_check", objectId: check.id, revision: 1, changeKind: `check_${verdict}`, at });
      const auditId = this.audit(ctx, principal, {
        action: "check/evaluate",
        subjectKind: "work_item_check",
        subjectId: check.id,
        before: { status: check.status },
        after: { status: verdict, evidenceSetHash: freshHash, autoClosed }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: itemAfter.id,
        objectRevision: itemAfter.revision,
        executionEpoch: itemAfter.execution_epoch,
        auditId,
        detail: { checkId: check.id, verdict, autoClosed, missing: snapshot.result.missing }
      });
    });
  }
  // ───────────────────────── T9 生命周期命令 ─────────────────────────
  pause(ctx, input) {
    return this.transitionCommand(ctx, "work_item/pause", input, "pause");
  }
  resume(ctx, input) {
    return this.transitionCommand(ctx, "work_item/resume", input, "resume");
  }
  cancel(ctx, input) {
    return this.transitionCommand(ctx, "work_item/cancel", input, "cancel");
  }
  reopen(ctx, input) {
    return this.transitionCommand(ctx, "work_item/reopen", input, "reopen");
  }
  retry(ctx, input) {
    return this.transitionCommand(ctx, "work_item/retry", input, "retry");
  }
  reportBlocker(ctx, input) {
    return this.command(ctx, "work_item/reportBlocker", input, () => {
      const principal = this.principal(ctx);
      if (principal.kind === "bot") requireCapability(principal, CAPABILITY.workItemExecute);
      else requireCapability(principal, CAPABILITY.workItemManage);
      const at = this.now();
      const item = this.workItemOrThrow(input.workItemId);
      if (!["ready", "active"].includes(item.status)) throw stateInvalid(`\u5F53\u524D\u72B6\u6001\u4E0D\u80FD\u62A5\u963B\u585E\uFF1A${item.status}`);
      const allowed = ["needs_evidence", "external", "dependency", "permission", "human_input", "data_source"];
      if (!allowed.includes(input.category)) throw stateInvalid(`\u672A\u77E5\u963B\u585E\u539F\u56E0\uFF1A${input.category}`);
      this.db.prepare(
        `UPDATE work_item
              SET status = 'blocked', blocked_reason = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`
      ).run(input.category, at, item.id);
      const running = this.db.prepare("SELECT id FROM task_run WHERE work_item_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(item.id);
      if (running) {
        this.db.prepare("UPDATE task_run SET status = 'failed', finished_at = ?, error_kind = ? WHERE id = ? AND status = 'running'").run(at, `blocked:${input.category}`, running.id);
        this.db.prepare("DELETE FROM lease WHERE run_id = ?").run(running.id);
      }
      const after = this.workItemOrThrow(item.id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "blocker_reported",
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { category: input.category, note: input.note },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: after.revision, changeKind: "blocked", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/reportBlocker",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { blockedReason: input.category, note: input.note }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId
      });
    });
  }
  unblock(ctx, input) {
    return this.command(ctx, "work_item/unblock", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.workItemManage);
      const at = this.now();
      const item = this.workItemOrThrow(input.workItemId);
      if (item.status !== "blocked") throw stateInvalid(`\u53EA\u6709 blocked \u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u89E3\u9664\u963B\u585E\uFF0C\u5F53\u524D ${item.status}`);
      const to = input.to ?? "ready";
      this.assertTransition(item.status, to);
      this.db.prepare(
        `UPDATE work_item
              SET status = ?, blocked_reason = NULL, revision = revision + 1, updated_at = ?
            WHERE id = ?`
      ).run(to, at, item.id);
      const after = this.workItemOrThrow(item.id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: "unblocked",
        actorId: principal.memberId,
        actorKind: "human",
        payload: { to },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: after.revision, changeKind: "unblocked", at });
      const auditId = this.audit(ctx, principal, {
        action: "work_item/unblock",
        subjectKind: "work_item",
        subjectId: item.id,
        after: { status: to }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId
      });
    });
  }
  // ───────────────────────── 项目（M6） ─────────────────────────
  /**
   * 项目列表。数据来自 `project` 与它关联的工作项/指标，不是样例；
   * 空库就返回空数组，界面负责显示「建第一个项目」的引导。
   */
  listProjects(ctx, filter = {}) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    return listProjects(this.db, filter).map((project) => {
      const count = (sql) => Number(this.db.prepare(sql).get(project.id, principal.memberId).n);
      const pending_my_count = count("SELECT COUNT(*) AS n FROM proposal WHERE project_id=? AND decider_id=? AND status='open'") + count("SELECT COUNT(*) AS n FROM project_review WHERE project_id=? AND confirmer_id=? AND status='awaiting_confirm'") + count("SELECT COUNT(*) AS n FROM project_phase WHERE project_id=? AND confirmer_id=? AND status='awaiting_confirm'") + count("SELECT COUNT(*) AS n FROM approval a JOIN work_item w ON w.id=a.subject_id WHERE w.project_id=? AND a.approver_id=? AND a.status='pending' AND a.subject_kind='work_item_close'");
      return { ...project, pending_my_count, needs_my_action: pending_my_count > 0 };
    });
  }
  getProjectDetail(ctx, projectId) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const detail = getProject(this.db, projectId);
    const extra = projectLifecycleDetail(this.db, projectId);
    const actions = this.projectActions(principal, detail);
    if (principal.kind === "human" && detail.status !== "archived") {
      if (principal.capabilities.has("target.publish")) actions.push("publishTarget");
      if (principal.capabilities.has(CAPABILITY.projectManage)) {
        actions.push("createPhase", "updatePhase", "createReview");
        if (extra.phases.some((p) => p.status === "awaiting_confirm" && p.confirmer_id === principal.memberId)) actions.push("confirmPhase");
      }
      if (principal.capabilities.has("review.confirm") && extra.reviews.some((r) => r.status === "awaiting_confirm" && r.confirmer_id === principal.memberId)) actions.push("confirmReview");
    }
    const phases = extra.phases.map((p) => ({ ...p, allowedActions: [
      ...actions.includes("updatePhase") && p.status !== "done" ? ["updatePhase"] : [],
      ...actions.includes("confirmPhase") && p.status === "awaiting_confirm" && p.confirmer_id === principal.memberId ? ["confirmPhase"] : []
    ] }));
    const reviews = extra.reviews.map((r) => ({ ...r, allowedActions: actions.includes("confirmReview") && r.status === "awaiting_confirm" && r.confirmer_id === principal.memberId ? ["confirmReview"] : [] }));
    return { ...detail, ...extra, phases, reviews, workItems: this.db.prepare("SELECT * FROM work_item WHERE project_id=? ORDER BY updated_at DESC,id").all(projectId), target_versions: detail.target_versions.map((v) => ({ ...v, metrics: this.db.prepare("SELECT * FROM project_metric WHERE version_id=? ORDER BY name").all(v.id) })), allowedActions: actions };
  }
  createProject(ctx, input) {
    return this.command(ctx, "project/create", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.projectCreate);
      const at = this.now();
      const created = insertProject(this.db, this.id, at, principal.memberId, input);
      const detail = getProject(this.db, created.id);
      writeChange(this.db, { objectKind: "project", objectId: created.id, revision: 1, changeKind: "created", at });
      const auditId = this.audit(ctx, principal, {
        action: "project/create",
        subjectKind: "project",
        subjectId: created.id,
        after: { name: detail.name, type: detail.type, status: detail.status, goal: detail.goal_text }
      });
      if (detail.status !== "draft") {
        ensureDefaultPlan(this.db, this.id, at, created.id);
        ensureDefaultAnalystInProject(this.db, created.id, detail.coordinator_id, principal.memberId, at);
      }
      return this.receipt(ctx, {
        status: "applied",
        objectId: created.id,
        objectRevision: created.revision,
        auditId,
        detail: {
          targetVersionId: created.targetVersionId,
          metrics: detail.metrics.length,
          coordinatorId: detail.coordinator_id,
          status: detail.status
        }
      });
    });
  }
  /**
   * 新建向导保存草稿：可只填名称，允许目标/指标为空。
   * 新建走 project.create 权限；续存自己的草稿也允许，改别人的草稿要 project.manage。
   */
  saveProjectDraft(ctx, input) {
    return this.command(ctx, "project/saveDraft", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      const at = this.now();
      if (input.projectId) {
        const existing = this.db.prepare("SELECT owner_human_id, status FROM project WHERE id = ? AND deleted_at IS NULL").get(input.projectId);
        if (!existing) throw stateInvalid(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${input.projectId}`);
        if (existing.status !== "draft") throw stateInvalid("\u53EA\u6709\u8349\u7A3F\u9879\u76EE\u53EF\u4EE5\u5728\u65B0\u5EFA\u5411\u5BFC\u91CC\u7EE7\u7EED\u4FEE\u6539");
        if (existing.owner_human_id !== principal.memberId) requireCapability(principal, CAPABILITY.projectManage);
      } else {
        requireCapability(principal, CAPABILITY.projectCreate);
      }
      const saved = saveProjectDraft(this.db, this.id, at, principal.memberId, input);
      if (saved.created) {
        writeChange(this.db, { objectKind: "project", objectId: saved.projectId, revision: saved.revision, changeKind: "draft_created", at });
      }
      const auditId = this.audit(ctx, principal, {
        action: "project/saveDraft",
        subjectKind: "project",
        subjectId: saved.projectId,
        after: { created: saved.created, revision: saved.revision, step: saved.step }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: saved.projectId,
        objectRevision: saved.revision,
        auditId,
        detail: { created: saved.created, step: saved.step, savedAt: saved.savedAt }
      });
    });
  }
  /** 删除归档项目：软删，工作项解绑保留；只有具备 project.archive 的人能做。 */
  deleteProject(ctx, input) {
    return this.command(ctx, "project/delete", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, "project.archive");
      const at = this.now();
      const deleted = softDeleteProject(this.db, at, principal.memberId, input.projectId);
      writeChange(this.db, {
        objectKind: "project",
        objectId: deleted.id,
        revision: deleted.revision,
        changeKind: "deleted",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "project/delete",
        subjectKind: "project",
        subjectId: deleted.id,
        after: { detachedWorkItems: deleted.detachedWorkItems, reason: input.reason ?? null }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: deleted.id,
        objectRevision: deleted.revision,
        auditId,
        detail: { detachedWorkItems: deleted.detachedWorkItems }
      });
    });
  }
  // ───────────────────────── 项目记忆 ─────────────────────────
  listProjectMemories(ctx, filter) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    return listProjectMemories(this.db, filter);
  }
  /** 人在项目「记忆」页签手写一条；能力类可以指定同步给哪个 bot。 */
  createProjectMemory(ctx, input) {
    return this.command(ctx, "project/memory/create", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.projectManage);
      const at = this.now();
      const created = createMemory(this.db, this.id, at, principal.memberId, {
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        origin: "manual",
        memberId: input.memberId ?? null,
        sourceRef: "manual"
      });
      writeChange(this.db, {
        objectKind: "project",
        objectId: input.projectId,
        revision: 0,
        changeKind: "memory.created",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "project/memory/create",
        subjectKind: "project_memory",
        subjectId: created.memory.id,
        after: { kind: created.memory.kind, title: created.memory.title, syncedTo: created.syncedTo }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: created.memory.id,
        objectRevision: created.memory.revision,
        auditId,
        detail: { projectId: input.projectId, created: created.created, syncedTo: created.syncedTo }
      });
    });
  }
  /** 改标题/正文，或归档/恢复；能力类记忆同步更新 bot 的副本。 */
  updateProjectMemory(ctx, input) {
    return this.command(ctx, "project/memory/update", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      const before = this.db.prepare("SELECT id, project_id, status, title FROM project_memory WHERE id = ?").get(input.memoryId);
      if (!before) throw stateInvalid(`\u8BB0\u5FC6\u4E0D\u5B58\u5728\uFF1A${input.memoryId}`);
      requireCapability(principal, CAPABILITY.projectManage);
      const at = this.now();
      const updated = updateMemory(this.db, at, input);
      writeChange(this.db, {
        objectKind: "project",
        objectId: before.project_id,
        revision: 0,
        changeKind: `memory.${updated.status}`,
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "project/memory/update",
        subjectKind: "project_memory",
        subjectId: updated.id,
        before: { status: before.status, title: before.title },
        after: { status: updated.status, title: updated.title }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: updated.id,
        objectRevision: updated.revision,
        auditId,
        detail: { projectId: before.project_id, status: updated.status }
      });
    });
  }
  /** 项目状态机：发布目标（draft→active）、暂停/继续、归档。归档能力是人专属。 */
  updateProjectStatus(ctx, input) {
    return this.command(ctx, "project/status", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      if (input.status === "archived") requireCapability(principal, "project.archive");
      else requireCapability(principal, CAPABILITY.projectManage);
      const at = this.now();
      const change = setProjectStatus(this.db, this.id, at, principal.memberId, input.projectId, input.status);
      if (change.before === "draft" && change.after === "active") {
        clearProjectDraft(this.db, input.projectId);
        ensureDefaultPlan(this.db, this.id, at, input.projectId);
        const coordinator = this.db.prepare("SELECT coordinator_id FROM project WHERE id = ?").get(input.projectId).coordinator_id;
        ensureDefaultAnalystInProject(this.db, input.projectId, coordinator, principal.memberId, at);
      }
      writeChange(this.db, {
        objectKind: "project",
        objectId: input.projectId,
        revision: change.revision,
        changeKind: `status:${change.after}`,
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "project/status",
        subjectKind: "project",
        subjectId: input.projectId,
        before: { status: change.before },
        after: { status: change.after, reason: input.reason ?? null, targetVersionId: change.targetVersionId }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: input.projectId,
        objectRevision: change.revision,
        auditId,
        detail: { before: change.before, after: change.after, targetVersionId: change.targetVersionId }
      });
    });
  }
  tryProjectMetric(ctx, input) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    if (input.projectId) projectRow(this.db, input.projectId);
    return tryMetric(this.db, this.now(), input.projectId, input.metric);
  }
  publishProjectTarget(ctx, input) {
    return this.projectCommand(ctx, "project/publishTarget", input, "target.publish", (p) => {
      const before = this.db.prepare("SELECT status,coordinator_id FROM project WHERE id=?").get(input.projectId);
      const result = publishTarget(this.db, this.id, this.now(), p.memberId, input);
      if (before.status === "draft") {
        const at = this.now();
        clearProjectDraft(this.db, input.projectId);
        ensureDefaultPlan(this.db, this.id, at, input.projectId);
        ensureDefaultAnalystInProject(this.db, input.projectId, before.coordinator_id, p.memberId, at);
      }
      return result;
    });
  }
  createProjectPhase(ctx, input) {
    return this.projectCommand(ctx, "project/createPhase", input, CAPABILITY.projectManage, (p) => createPhase(this.db, this.id, p.memberId, input));
  }
  updateProjectPhase(ctx, input) {
    return this.projectCommand(ctx, "project/updatePhase", input, CAPABILITY.projectManage, (p) => updatePhase(this.db, this.now(), p.memberId, input));
  }
  updateProjectTarget(ctx, input) {
    return this.projectCommand(ctx, "project/updateTarget", input, CAPABILITY.projectManage, (p) => updatePhaseTarget(this.db, input));
  }
  addProjectTarget(ctx, input) {
    return this.projectCommand(ctx, "project/addTarget", input, CAPABILITY.projectManage, () => addPhaseTarget(this.db, this.id, input));
  }
  submitProjectTargetCheck(ctx, input) {
    return this.projectCommand(ctx, "project/submitTargetCheck", input, CAPABILITY.projectManage, (p) => {
      const approver = resolvePrincipal(this.db, input.approverId, this.now());
      requireHuman(approver);
      requireCapability(approver, CAPABILITY.approvalDecide);
      return submitTargetCheck(this.db, this.id, this.now(), p.memberId, input);
    });
  }
  confirmProjectPhase(ctx, input) {
    return this.projectCommand(ctx, "project/confirmPhase", input, CAPABILITY.projectManage, (p) => confirmPhase(this.db, this.now(), p.memberId, input));
  }
  createProjectReview(ctx, input) {
    return this.projectCommand(ctx, "project/createReview", input, CAPABILITY.projectManage, (p) => createReview(this.db, this.id, this.now(), p.memberId, input));
  }
  confirmProjectReview(ctx, input) {
    return this.projectCommand(ctx, "project/confirmReview", input, "review.confirm", (p) => confirmReview(this.db, this.now(), p.memberId, input));
  }
  projectCommand(ctx, action, input, capability, apply2) {
    return this.command(ctx, action, input, () => {
      const p = this.principal(ctx);
      requireHuman(p);
      requireCapability(p, capability);
      if (ctx.channel !== "ui") throw denied("\u9879\u76EE\u53D1\u5E03\u4E0E\u4EBA\u5DE5\u786E\u8BA4\u53EA\u80FD\u901A\u8FC7UI\u901A\u9053");
      const project = projectRow(this.db, input.projectId);
      if (project.status === "archived") throw stateInvalid("\u5F52\u6863\u9879\u76EE\u4E0D\u80FD\u4FEE\u6539");
      const result = apply2(p), at = this.now(), revision = project.revision + 1;
      this.db.prepare("UPDATE project SET revision=?,updated_at=? WHERE id=?").run(revision, at, project.id);
      writeChange(this.db, { objectKind: "project", objectId: project.id, revision, changeKind: action.split("/")[1], at });
      const auditId = this.audit(ctx, p, { action, subjectKind: "project", subjectId: project.id, before: { revision: project.revision }, after: { ...input, ...result } });
      return this.receipt(ctx, { status: "applied", objectId: project.id, objectRevision: revision, auditId, detail: result });
    });
  }
  /** 记一条指标读数；`value=null` 表示缺数（界面必须显示「未知」而不是达标）。 */
  recordMetric(ctx, input) {
    return this.command(ctx, "project/recordMetric", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.metricRecord);
      const at = this.now();
      const observation = recordObservation(this.db, this.id, at, input);
      writeChange(this.db, {
        objectKind: "project",
        objectId: input.projectId,
        revision: 0,
        changeKind: "metric.observed",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "project/recordMetric",
        subjectKind: "metric_observation",
        subjectId: observation.id,
        after: {
          projectId: input.projectId,
          metricId: observation.metricId,
          value: observation.value,
          windowStart: observation.windowStart,
          windowEnd: observation.windowEnd
        }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: input.projectId,
        auditId,
        detail: { observationId: observation.id, metricId: observation.metricId }
      });
    });
  }
  projectActions(principal, detail) {
    const has = (capability) => principal.kind === "system" || principal.capabilities.has(capability);
    const actions = [];
    if (detail.status !== "archived" && has(CAPABILITY.projectCreate)) actions.push("createWorkItem");
    if (principal.kind === "human" && has(CAPABILITY.projectManage)) {
      if (detail.status === "draft") actions.push("publish");
      if (detail.status === "active") actions.push("pause");
      if (detail.status === "paused") actions.push("resume");
    }
    if (principal.kind === "human" && has("project.archive") && detail.status !== "archived") actions.push("archive");
    if (principal.kind === "human" && has(CAPABILITY.projectCreate) && detail.status === "draft") actions.push("continueDraft");
    if (principal.kind === "human" && has("project.archive") && detail.status === "archived") actions.push("delete");
    if (principal.kind === "human" && has(CAPABILITY.projectManage) && detail.status !== "archived") actions.push("manageMemory");
    return actions;
  }
  // ───────────────────────── 人机成员（M6） ─────────────────────────
  listMembers(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    return listMembers(this.db, this.now(), filter);
  }
  getMemberDetail(ctx, memberId) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const detail = getMember(this.db, this.now(), memberId);
    const actions = [];
    const canManage = principal.kind === "human" && principal.capabilities.has("member.manage");
    if (canManage && memberId !== principal.memberId && detail.kind !== "system") {
      if (detail.status === "active") actions.push("pause", "retire");
      if (detail.status === "paused") actions.push("resume", "retire");
      if (detail.status === "retired") actions.push("resume");
    }
    if (canManage && detail.kind === "bot" && detail.status !== "retired") actions.push("publishConfig");
    const bot_versions = this.db.prepare("SELECT * FROM member_version WHERE member_id=? ORDER BY version DESC").all(memberId).map((v) => ({ ...v, memory_scope: JSON.parse(v.memory_scope_json), skills: this.db.prepare("SELECT * FROM member_version_skill WHERE member_version_id=?").all(v.id), responsibility: this.db.prepare("SELECT after_json FROM audit_log WHERE subject_kind='member' AND subject_id=? AND action IN ('member/publishConfig','member/create') ORDER BY created_at DESC,rowid DESC").all(memberId).map((a) => JSON.parse(a.after_json)).find((a) => a.versionId === v.id || a.version === v.version)?.responsibility ?? null }));
    return { ...detail, bot_versions, memories: listMemberMemories(this.db, memberId), activity: memberActivity(this.db, this.now(), memberId, this.timeZone), allowedActions: actions };
  }
  listPositions(ctx) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    return listPositions(this.db);
  }
  createMember(ctx, input) {
    return this.command(ctx, "member/create", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, "member.manage");
      const at = this.now();
      const created = insertMember(this.db, this.id, at, principal.memberId, input);
      writeChange(this.db, {
        objectKind: "member",
        objectId: created.id,
        revision: created.version,
        changeKind: "created",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "member/create",
        subjectKind: "member",
        subjectId: created.id,
        after: { kind: created.kind, version: created.version, capabilities: created.capabilities, responsibility: input.responsibility ?? "", model: input.model ?? null, agentPreset: input.agentPreset ?? null, prompt: input.prompt ?? "", memoryScope: {} }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: created.id,
        objectRevision: created.version,
        auditId,
        detail: { kind: created.kind, capabilities: created.capabilities }
      });
    });
  }
  publishMemberConfig(ctx, input) {
    return this.command(ctx, "member/publishConfig", input, () => {
      const p = this.principal(ctx);
      requireHuman(p);
      requireCapability(p, "member.manage");
      if (ctx.channel !== "ui") throw denied("\u914D\u7F6E\u53D1\u5E03\u53EA\u80FD\u901A\u8FC7UI\u901A\u9053");
      const at = this.now(), result = publishConfig(this.db, this.id, at, p.memberId, input);
      writeChange(this.db, { objectKind: "member", objectId: input.memberId, revision: result.version, changeKind: "config_published", at });
      const auditId = this.audit(ctx, p, { action: "member/publishConfig", subjectKind: "member", subjectId: input.memberId, after: result });
      return this.receipt(ctx, { status: "applied", objectId: input.memberId, objectRevision: result.version, auditId, detail: result });
    });
  }
  updateMemberStatus(ctx, input) {
    return this.command(ctx, "member/status", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, "member.manage");
      const at = this.now();
      const change = setMemberStatus(this.db, at, principal.memberId, input.memberId, input.status);
      writeChange(this.db, {
        objectKind: "member",
        objectId: input.memberId,
        revision: 0,
        changeKind: `status:${change.after}`,
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "member/status",
        subjectKind: "member",
        subjectId: input.memberId,
        before: { status: change.before },
        after: { status: change.after, closedPositions: change.closedPositions }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: input.memberId,
        auditId,
        detail: change
      });
    });
  }
  // ───────────────────────── 知识（M6，真实来源） ─────────────────────────
  knowledgeOrThrow() {
    if (!this.knowledgeService) {
      throw new HamsError("HOST_CAPABILITY_MISSING", "\u77E5\u8BC6\u6570\u636E\u6E90\u672A\u914D\u7F6E\uFF08\u7F3A\u5C11 dataDir\uFF09", {
        nextStep: "\u68C0\u67E5\u63D2\u4EF6\u914D\u7F6E\u7684 dataDir \u662F\u5426\u4E3A\u7A7A"
      });
    }
    return this.knowledgeService;
  }
  listKnowledge(ctx, filter = {}) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    return this.knowledgeOrThrow().list(filter);
  }
  getKnowledge(ctx, input) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const detail = this.knowledgeOrThrow().get(input.kind, input.id);
    const actions = [];
    const canWrite = principal.kind === "system" || principal.capabilities.has(CAPABILITY.knowledgeWrite);
    if (detail.kind === "doc" && canWrite) {
      if ("source_kind" in detail && detail.source_kind === "hams") actions.push("edit");
      if ("status" in detail && detail.status === "draft") actions.push("publish");
    }
    if (detail.kind === "skill" && principal.kind === "human" && principal.capabilities.has(CAPABILITY.knowledgeSync)) {
      actions.push("sync");
    }
    return { ...detail, allowedActions: actions };
  }
  /** 技能镜像 + 业务表结构登记，来源都是本机真实数据；重复执行幂等。 */
  syncKnowledge(ctx) {
    return this.command(ctx, "knowledge/sync", {}, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.knowledgeSync);
      const at = this.now();
      const report = this.knowledgeOrThrow().sync(principal.memberId);
      writeChange(this.db, {
        objectKind: "knowledge",
        objectId: "sync",
        revision: 0,
        changeKind: "synced",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "knowledge/sync",
        subjectKind: "knowledge",
        subjectId: "sync",
        after: {
          skills: { created: report.skills.created, updated: report.skills.updated, unchanged: report.skills.unchanged },
          tables: { created: report.tables.created, updated: report.tables.updated }
        }
      });
      return this.receipt(ctx, { status: "applied", auditId, detail: { report } });
    });
  }
  /** 新建一律是草稿：发布必须走 `publishKnowledgeDoc`（人），避免 bot 或界面绕过发布关卡。 */
  createKnowledgeDoc(ctx, input) {
    return this.command(ctx, "knowledge/createDoc", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.knowledgeWrite);
      const at = this.now();
      const created = this.knowledgeOrThrow().createDoc(principal.memberId, {
        title: input.title,
        body: input.body,
        status: "draft"
      });
      writeChange(this.db, {
        objectKind: "kb_doc",
        objectId: created.id,
        revision: created.revision,
        changeKind: "created",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "knowledge/createDoc",
        subjectKind: "kb_doc",
        subjectId: created.id,
        after: { title: input.title, revision: created.revision, path: created.path }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: created.id,
        objectRevision: created.revision,
        auditId,
        detail: { path: created.path }
      });
    });
  }
  updateKnowledgeDoc(ctx, input) {
    return this.command(ctx, "knowledge/updateDoc", input, () => {
      const principal = this.principal(ctx);
      requireCapability(principal, CAPABILITY.knowledgeWrite);
      const allowForeign = principal.kind === "system" || principal.capabilities.has("member.manage");
      const at = this.now();
      const updated = this.knowledgeOrThrow().updateDoc(
        principal.memberId,
        input.docId,
        { title: input.title, body: input.body, expectedRevision: input.expectedRevision },
        allowForeign
      );
      writeChange(this.db, {
        objectKind: "kb_doc",
        objectId: input.docId,
        revision: updated.revision,
        changeKind: "updated",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "knowledge/updateDoc",
        subjectKind: "kb_doc",
        subjectId: input.docId,
        after: { revision: updated.revision, title: input.title ?? null }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: input.docId,
        objectRevision: updated.revision,
        auditId,
        detail: { path: updated.path }
      });
    });
  }
  publishKnowledgeDoc(ctx, input) {
    return this.command(ctx, "knowledge/publishDoc", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.knowledgeWrite);
      const allowForeign = principal.capabilities.has("member.manage");
      const at = this.now();
      const published = this.knowledgeOrThrow().publishDoc(principal.memberId, input.docId, allowForeign);
      writeChange(this.db, {
        objectKind: "kb_doc",
        objectId: input.docId,
        revision: 0,
        changeKind: "published",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "knowledge/publishDoc",
        subjectKind: "kb_doc",
        subjectId: input.docId,
        after: { status: published.status }
      });
      return this.receipt(ctx, { status: "applied", objectId: input.docId, auditId, detail: published });
    });
  }
  /** 导入本机目录里的 Markdown（只登记路径与哈希，不复制文件）。 */
  importKnowledgeDocs(ctx, input) {
    return this.command(ctx, "knowledge/importDocs", input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.knowledgeWrite);
      const at = this.now();
      const report = this.knowledgeOrThrow().importDocs(principal.memberId, input);
      writeChange(this.db, {
        objectKind: "knowledge",
        objectId: report.dir,
        revision: 0,
        changeKind: "imported",
        at
      });
      const auditId = this.audit(ctx, principal, {
        action: "knowledge/importDocs",
        subjectKind: "knowledge",
        subjectId: report.dir,
        after: { scanned: report.scanned, imported: report.imported, updated: report.updated, skipped: report.skipped }
      });
      return this.receipt(ctx, { status: "applied", auditId, detail: { report } });
    });
  }
  // ───────────────────────── 内部：事务边界与幂等 ─────────────────────────
  command(ctx, action, payload, run) {
    const payloadHash = hashPayload(payload);
    const scopeKey = ctx.idempotencyKey ? receiptScopeKey(ctx.principalId, action, ctx.idempotencyKey) : null;
    if (this.db.isTransaction) throw new HamsError("STATE_INVALID", "\u547D\u4EE4\u4E0D\u80FD\u5728\u5DF2\u6709\u4E8B\u52A1\u5185\u6267\u884C");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (scopeKey) {
        const stored = loadReceipt(this.db, scopeKey);
        if (stored) {
          if (stored.payloadHash !== payloadHash) {
            throw new HamsError("IDEMPOTENCY_MISMATCH", "\u540C\u4E00\u5E42\u7B49\u952E\u6536\u5230\u4E86\u4E0D\u540C\u8F7D\u8377", {
              nextStep: "\u6362\u4E00\u4E2A\u5E42\u7B49\u952E\u91CD\u8BD5"
            });
          }
          const receipt2 = JSON.parse(stored.receiptJson);
          this.db.exec("COMMIT");
          return receipt2;
        }
      }
      const target = payload;
      if (ctx.expectedRevision !== void 0) {
        let current;
        if (typeof target.workItemId === "string") current = this.workItemOrThrow(target.workItemId).revision;
        else if (typeof target.projectId === "string") current = projectRow(this.db, target.projectId).revision;
        else if (typeof target.memberId === "string") current = this.db.prepare("SELECT current_version FROM member WHERE id=?").get(target.memberId)?.current_version;
        if (current !== void 0 && current !== ctx.expectedRevision) throw new HamsError("VERSION_CONFLICT", `\u5BF9\u8C61\u4FEE\u8BA2\u53F7\u5DF2\u53D8\uFF1A\u671F\u671B ${ctx.expectedRevision}\uFF0C\u5F53\u524D ${current}`);
      }
      const receipt = run();
      if (scopeKey) {
        saveReceipt(this.db, {
          scopeKey,
          commandId: ctx.correlationId,
          principalId: ctx.principalId,
          action,
          payloadHash,
          receiptJson: JSON.stringify(receipt),
          at: this.now()
        });
      }
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  principal(ctx) {
    return resolvePrincipal(this.db, ctx.principalId, this.now());
  }
  receipt(ctx, input) {
    return {
      ok: input.status !== "rejected",
      status: input.status,
      objectId: input.objectId,
      objectRevision: input.objectRevision,
      executionEpoch: input.executionEpoch,
      approvalId: input.approvalId,
      auditId: input.auditId,
      correlationId: ctx.correlationId,
      detail: input.detail
    };
  }
  audit(ctx, principal, entry) {
    const auditId = this.id();
    writeAudit(this.db, auditId, {
      actorId: principal.memberId,
      actorKind: principal.kind,
      onBehalfOf: ctx.onBehalfOf ?? null,
      channel: ctx.channel,
      authSubject: ctx.authSubject ?? null,
      hostPreset: ctx.hostPreset ?? null,
      action: entry.action,
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      before: entry.before,
      after: entry.after,
      correlationId: ctx.correlationId,
      at: this.now()
    });
    return auditId;
  }
  // ───────────────────────── 内部：工作项与关联行 ─────────────────────────
  factory() {
    return { db: this.db, ids: this.id, now: this.now, timeZone: this.timeZone };
  }
  createWorkItemTx(_ctx, principal, input) {
    return insertWorkItem(this.factory(), {
      domain: input.domain,
      category: input.category,
      title: input.title,
      ownerHumanId: input.ownerHumanId,
      projectId: input.projectId ?? null,
      templateVersionId: input.templateVersionId ?? null,
      assetId: input.assetId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy,
      actorKind: principal.kind
    });
  }
  upsertAsset(input) {
    const existing = this.db.prepare("SELECT id FROM asset WHERE external_system = ? AND external_id = ?").get(input.externalSystem, input.externalId);
    if (existing) return existing.id;
    const assetId = this.id();
    this.db.prepare(
      `INSERT INTO asset (id, external_system, external_id, kind, display_name) VALUES (?, ?, ?, ?, ?)`
    ).run(assetId, input.externalSystem, input.externalId, input.kind ?? "battery", input.displayName);
    return assetId;
  }
  ensureThreadTx(principal, item, sessionId) {
    const active = this.db.prepare(
      `SELECT * FROM work_item_thread
          WHERE work_item_id = ? AND member_id = ? AND status IN ('active','pending_rotate')
          ORDER BY generation DESC LIMIT 1`
    ).get(item.id, principal.memberId);
    if (active) {
      const major = this.db.prepare("SELECT version FROM member_version WHERE member_id=? AND version>? AND change_class='major' ORDER BY version DESC LIMIT 1").get(principal.memberId, active.member_version);
      if (!major && active.status === "active") return active;
      if (!sessionId || sessionId === active.session_id) throw new HamsError("HOST_CAPABILITY_MISSING", "\u914D\u7F6E\u5927\u6539\u6216\u4F1A\u8BDD\u8FBE\u5230\u6362\u4EE3\u6761\u4EF6\uFF0C\u9700\u8981\u5BBF\u4E3B\u521B\u5EFA\u65B0\u4F1A\u8BDD", { nextStep: "\u521B\u5EFA\u65B0\u4F1A\u8BDD\u540E\u5E26\u65B0sessionId\u8BA4\u9886" });
      this.closeThreadTx(item.id, major ? "config_major" : "rotation", this.now());
    }
    if (!sessionId || !sessionId.trim()) {
      throw new HamsError("HOST_CAPABILITY_MISSING", "\u65B0\u5EFA\u7EBF\u7A0B\u9700\u8981\u5BBF\u4E3B\u4F1A\u8BDD id", {
        nextStep: "\u5148\u7531\u5BBF\u4E3B\u521B\u5EFA\u4F1A\u8BDD\uFF0C\u518D\u5E26\u7740 sessionId \u8BA4\u9886"
      });
    }
    const taken = this.db.prepare("SELECT work_item_id FROM work_item_thread WHERE session_id = ?").get(sessionId);
    if (taken) throw stateInvalid(`\u4F1A\u8BDD\u5DF2\u7ED1\u5B9A\u5230\u5176\u5B83\u5DE5\u4F5C\u9879\uFF1A${sessionId}`);
    const maxGen = this.db.prepare("SELECT COALESCE(MAX(generation), 0) AS g FROM work_item_thread WHERE work_item_id = ?").get(item.id);
    const threadId = this.id();
    this.db.prepare(
      `INSERT INTO work_item_thread
           (id, work_item_id, generation, session_id, member_id, member_version, status, turn_count,
            rotate_after_turns, rotate_after_days, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 200, 30, ?)`
    ).run(threadId, item.id, Number(maxGen.g) + 1, sessionId, principal.memberId, principal.currentVersion, this.now());
    return this.db.prepare("SELECT * FROM work_item_thread WHERE id = ?").get(threadId);
  }
  closeThreadTx(workItemId, reason, at) {
    this.db.prepare(
      `UPDATE work_item_thread
            SET status = 'closed', closed_at = ?, close_reason = ?
          WHERE work_item_id = ? AND status IN ('active','pending_rotate')`
    ).run(at, reason, workItemId);
  }
  resolveApproverTx(policy, item, at) {
    if (policy.approver === "owner") {
      const owner = this.memberOrThrow(item.owner_human_id);
      if (owner.kind !== "human") throw denied("\u8D1F\u8D23\u4EBA\u4E0D\u662F\u4EBA\uFF0C\u65E0\u6CD5\u4F5C\u4E3A\u5BA1\u6279\u4EBA");
      return item.owner_human_id;
    }
    const positionId = policy.approver.slice("position:".length);
    const row = this.db.prepare(
      `SELECT mp.member_id AS member_id
           FROM member_position mp
           JOIN member m ON m.id = mp.member_id AND m.kind = 'human' AND m.status = 'active'
          WHERE mp.position_id = ? AND mp.starts_at <= ? AND (mp.ends_at IS NULL OR mp.ends_at > ?)
          ORDER BY mp.starts_at DESC LIMIT 1`
    ).get(positionId, at, at);
    if (!row) throw denied(`\u5C97\u4F4D ${positionId} \u5F53\u524D\u6CA1\u6709\u5728\u5C97\u7684\u4EBA\uFF0C\u65E0\u6CD5\u89E3\u6790\u5BA1\u6279\u4EBA`, "\u5B89\u6392\u5728\u5C97\u4EBA\u5458\u6216\u6539\u7528 owner \u5BA1\u6279");
    return row.member_id;
  }
  requestChannel(ctx) {
    if (ctx.channel === "tool") return "tool";
    if (ctx.channel === "ui") return "ui";
    return "system";
  }
  // ───────────────────────── 内部：生命周期通用 ─────────────────────────
  transitionCommand(ctx, action, input, kind) {
    return this.command(ctx, action, input, () => {
      const principal = this.principal(ctx);
      requireHuman(principal);
      requireCapability(principal, CAPABILITY.workItemManage);
      const at = this.now();
      const item = this.workItemOrThrow(input.workItemId);
      let target;
      let resumeState = null;
      if (kind === "pause") {
        if (item.status === "paused") throw stateInvalid("\u5DE5\u4F5C\u9879\u5DF2\u7ECF\u6682\u505C");
        target = "paused";
        resumeState = item.status;
      } else if (kind === "resume") {
        if (item.status !== "paused" || !item.resume_state) throw stateInvalid("\u5DE5\u4F5C\u9879\u4E0D\u5728\u6682\u505C\u72B6\u6001");
        target = item.resume_state;
      } else if (kind === "cancel") {
        target = "cancelled";
      } else if (kind === "reopen") {
        target = "ready";
      } else {
        target = "ready";
      }
      this.assertTransition(item.status, target);
      const linkage = this.bumpEpochLinkageTx(item.id, at);
      this.db.prepare(
        `UPDATE work_item
              SET status = ?, resume_state = ?, revision = revision + 1, execution_epoch = execution_epoch + 1,
                  updated_at = ?${kind === "reopen" ? ", completed_at = NULL" : ""}
            WHERE id = ?`
      ).run(target, resumeState, at, item.id);
      let after = this.workItemOrThrow(item.id);
      if (kind === "resume" && target === "waiting_check") {
        const previous = this.db.prepare("SELECT * FROM work_item_check WHERE work_item_id=? ORDER BY generation DESC LIMIT 1").get(item.id);
        if (previous) {
          const generation = after.check_generation + 1, checkId = this.id();
          this.db.prepare("INSERT INTO work_item_check (id,work_item_id,generation,execution_epoch,template_version_id,planned_due_at,status,created_at) VALUES (?,?,?,?,?,?,'scheduled',?)").run(checkId, item.id, generation, after.execution_epoch, previous.template_version_id, previous.planned_due_at, at);
          this.db.prepare("UPDATE work_item SET check_generation=?,next_action_at=?,revision=revision+1 WHERE id=?").run(generation, Math.max(at, previous.planned_due_at), item.id);
          if (previous.planned_due_at <= at && after.assignee_id) {
            const thread = this.db.prepare("SELECT * FROM work_item_thread WHERE work_item_id=? AND member_id=? AND status='active' ORDER BY generation DESC LIMIT 1").get(item.id, after.assignee_id);
            if (thread) {
              const fence = after.fence_seq + 1, runId = this.id();
              this.db.prepare("UPDATE work_item SET fence_seq=?,revision=revision+1 WHERE id=?").run(fence, item.id);
              this.db.prepare("INSERT INTO task_run (id,work_item_id,thread_id,check_id,member_id,member_version,execution_epoch,runtime_epoch,fence,trigger,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'check','queued',?)").run(runId, item.id, thread.id, checkId, thread.member_id, thread.member_version, after.execution_epoch, this.runtimeEpoch, fence, at);
              this.db.prepare("UPDATE work_item_check SET status='running' WHERE id=?").run(checkId);
              writeChange(this.db, { objectKind: "task_run", objectId: runId, revision: 1, changeKind: "check_run_queued", at });
            }
          }
        }
      }
      after = this.workItemOrThrow(item.id);
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: `work_item_${kind}`,
        actorId: principal.memberId,
        actorKind: "human",
        payload: { from: item.status, to: target, reason: input.reason ?? "", linkage },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at
      });
      writeChange(this.db, { objectKind: "work_item", objectId: item.id, revision: after.revision, changeKind: kind, at });
      const auditId = this.audit(ctx, principal, {
        action,
        subjectKind: "work_item",
        subjectId: item.id,
        before: { status: item.status, executionEpoch: item.execution_epoch },
        after: { status: target, executionEpoch: after.execution_epoch, linkage }
      });
      return this.receipt(ctx, {
        status: "applied",
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
        detail: { status: target, linkage }
      });
    });
  }
  /** T9 的「六件事」里与其它表联动的部分；epoch/revision 已在同一条 UPDATE 里升过。 */
  bumpEpochLinkageTx(workItemId, at) {
    const runs = this.db.prepare(
      `UPDATE task_run SET status = 'cancelled', finished_at = ?
          WHERE work_item_id = ? AND status IN ('queued','running')`
    ).run(at, workItemId);
    const checks = this.db.prepare(
      `UPDATE work_item_check SET status = 'cancelled'
          WHERE work_item_id = ? AND status = 'scheduled'`
    ).run(workItemId);
    const approvals = this.db.prepare(
      `UPDATE approval SET status = 'withdrawn'
          WHERE subject_id = ? AND subject_kind IN ('work_item_close','evidence_override','asset_disposal')
            AND status = 'pending'`
    ).run(workItemId);
    const outbox = this.db.prepare(
      `UPDATE outbox SET status = 'cancelled'
          WHERE work_item_id = ? AND status = 'pending'`
    ).run(workItemId);
    const leases = this.db.prepare("DELETE FROM lease WHERE work_item_id = ?").run(workItemId);
    return {
      cancelledRuns: Number(runs.changes),
      cancelledChecks: Number(checks.changes),
      withdrawnApprovals: Number(approvals.changes),
      cancelledOutbox: Number(outbox.changes),
      releasedLeases: Number(leases.changes)
    };
  }
  assertTransition(from, to) {
    const row = this.db.prepare("SELECT command FROM work_item_transition WHERE from_status = ? AND to_status = ?").get(from, to);
    if (!row) throw stateInvalid(`\u72B6\u6001\u8F6C\u6362\u4E0D\u5728\u767D\u540D\u5355\uFF1A${from} \u2192 ${to}`);
  }
  allowedActions(principal, item) {
    const actions = [];
    const has = (capability) => principal.kind === "system" || principal.capabilities.has(capability);
    if (item.status === "ready" && has(CAPABILITY.workItemAccept) && principal.kind === "human") actions.push("accept");
    if (item.status === "ready" && has(CAPABILITY.workItemClaim) && principal.kind === "bot") actions.push("claim");
    if (item.status === "waiting_review" && has(CAPABILITY.approvalDecide)) actions.push("decideApproval");
    if (["active", "waiting_check", "waiting_review", "blocked"].includes(item.status) && has(CAPABILITY.workItemRequestClosure) && !this.db.prepare("SELECT id FROM approval WHERE subject_id=? AND subject_kind='work_item_close' AND status='pending' AND expires_at>? LIMIT 1").get(item.id, this.now())) {
      actions.push("requestClosure");
    }
    if (has(CAPABILITY.evidenceAppend)) actions.push("addEvidence");
    if (["ready", "active"].includes(item.status) && has(principal.kind === "bot" ? CAPABILITY.workItemExecute : CAPABILITY.workItemManage)) actions.push("reportBlocker");
    if (principal.kind === "human" && has(CAPABILITY.workItemManage)) {
      if (!TERMINAL_ITEM_STATUSES.includes(item.status)) {
        actions.push("cancel");
        if (item.status !== "paused") actions.push("pause");
      }
      if (item.status === "paused") actions.push("resume");
      if (item.status === "completed") actions.push("reopen");
      if (item.status === "failed") actions.push("retry");
      if (item.status === "blocked") actions.push("unblock");
      if (!TERMINAL_ITEM_STATUSES.includes(item.status) && item.assignee_id && this.db.prepare("SELECT id FROM member WHERE id=? AND kind='bot' AND status='active'").get(item.assignee_id) && !this.db.prepare("SELECT id FROM task_run WHERE work_item_id=? AND status='running'").get(item.id)) actions.push("rotateThread");
    }
    return actions;
  }
  // ───────────────────────── 内部：取行与工具 ─────────────────────────
  workItemOrThrow(id) {
    const row = this.db.prepare("SELECT * FROM work_item WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u5DE5\u4F5C\u9879\u4E0D\u5B58\u5728\uFF1A${id}`);
    return row;
  }
  runOrThrow(id) {
    const row = this.db.prepare("SELECT * FROM task_run WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u8FD0\u884C\u4E0D\u5B58\u5728\uFF1A${id}`);
    return row;
  }
  checkOrThrow(id) {
    const row = this.db.prepare("SELECT * FROM work_item_check WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u590D\u67E5\u4E0D\u5B58\u5728\uFF1A${id}`);
    return row;
  }
  approvalOrThrow(id) {
    const row = this.db.prepare("SELECT * FROM approval WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u5BA1\u6279\u4E0D\u5B58\u5728\uFF1A${id}`);
    return row;
  }
  memberOrThrow(id) {
    const row = this.db.prepare("SELECT id, kind FROM member WHERE id = ?").get(id);
    if (!row) throw stateInvalid(`\u6210\u5458\u4E0D\u5B58\u5728\uFF1A${id}`);
    return row;
  }
  templateVersionTx(id) {
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM work_template_version WHERE id = ?").get(id);
    return row ?? null;
  }
  evidenceRows(workItemId) {
    return this.db.prepare("SELECT * FROM evidence WHERE work_item_id = ? ORDER BY id").all(workItemId);
  }
  /** 领域函数只认 camelCase 快照，避免把 snake_case 行直接喂给哈希（那样会全员 undefined）。 */
  evidenceSnapshots(workItemId) {
    return this.evidenceRows(workItemId).map((row) => ({
      id: row.id,
      kind: row.kind,
      contentHash: row.content_hash,
      observedAt: row.observed_at,
      status: row.status
    }));
  }
  findOpenByDedupeKey(dedupeKey) {
    if (!dedupeKey) return null;
    const placeholders = OPEN_ITEM_STATUSES.map(() => "?").join(",");
    const row = this.db.prepare(`SELECT * FROM work_item WHERE dedupe_key = ? AND status IN (${placeholders}) LIMIT 1`).get(dedupeKey, ...OPEN_ITEM_STATUSES);
    return row ?? null;
  }
  readRuntimeEpoch() {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get();
    return Number(row?.value ?? 0);
  }
  parseJsonObject(json2) {
    if (!json2 || !json2.trim()) return {};
    try {
      const parsed = JSON.parse(json2);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
};

// src/service/contracts.ts
var NEXT_STEP = {
  VERSION_CONFLICT: "\u5237\u65B0\u540E\u5728\u6700\u65B0\u7248\u672C\u4E0A\u91CD\u505A\uFF1B\u4F60\u7684\u8F93\u5165\u4E0D\u4F1A\u4E22",
  EVIDENCE_CHANGED: "\u6750\u6599\u5DF2\u53D8\uFF0C\u8BF7\u6309\u65B0\u6750\u6599\u91CD\u65B0\u7533\u8BF7",
  APPROVAL_EXPIRED: "\u8FD9\u5F20\u5BA1\u6279\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7",
  NOT_APPROVER: "\u53EA\u6709\u7533\u8BF7\u65F6\u6307\u5B9A\u7684\u5BA1\u6279\u4EBA\u53EF\u4EE5\u5904\u7406",
  POLICY_DENIED: "\u786E\u8BA4\u5C97\u4F4D\u662F\u5426\u5728\u5C97\u3001\u662F\u5426\u5177\u5907\u8BE5\u80FD\u529B\uFF1B\u9700\u8981\u65F6\u627E\u7BA1\u7406\u5458\u6388\u6743",
  STATE_INVALID: "\u5237\u65B0\u540E\u91CD\u8BD5\uFF1B\u82E5\u72B6\u6001\u5DF2\u53D8\uFF0C\u6309\u5F53\u524D\u72B6\u6001\u91CC\u7684\u53EF\u7528\u52A8\u4F5C\u64CD\u4F5C",
  EPOCH_STALE: "\u8FD9\u6B21\u64CD\u4F5C\u5DF2\u56E0\u751F\u547D\u5468\u671F\u53D8\u5316\u4F5C\u5E9F\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u6765",
  APPROVAL_REQUIRED: "\u5148\u53BB\u7533\u8BF7\u5173\u5355\uFF0C\u7B49\u6709\u6548\u5BA1\u6279\u901A\u8FC7",
  EVIDENCE_INCOMPLETE: "\u8865\u9F50\u7F3A\u7684\u8BC1\u636E\u540E\u91CD\u65B0\u7533\u8BF7",
  LEASE_LOST: "\u79DF\u7EA6\u5DF2\u88AB\u56DE\u6536\uFF0C\u8FD0\u884C\u7ED3\u679C\u8BB0\u4E3A\u672A\u77E5\uFF0C\u8BF7\u6838\u5BF9\u540E\u518D\u91CD\u8BD5",
  IDEMPOTENCY_MISMATCH: "\u540C\u4E00\u5E42\u7B49\u952E\u4E0D\u80FD\u6539\u8F7D\u8377\uFF1B\u8BF7\u6362\u4E00\u4E2A\u5E42\u7B49\u952E\u91CD\u8BD5",
  CURSOR_EXPIRED: "\u6E38\u6807\u5DF2\u8D85\u51FA\u4FDD\u7559\u671F\uFF0C\u8BF7\u91CD\u65B0\u62C9\u53D6\u5FEB\u7167",
  DATA_STALE: "\u6570\u636E\u6E90\u5DF2\u8FC7\u671F\uFF0C\u7ED3\u8BBA\u53EA\u80FD\u8BB0\u300C\u65E0\u6CD5\u5224\u65AD\u300D",
  EXTERNAL_RESULT_UNKNOWN: "\u5916\u90E8\u52A8\u4F5C\u7ED3\u679C\u4E0D\u660E\uFF0C\u8BF7\u53BB\u5BF9\u8D26\uFF0C\u4E0D\u8981\u76F4\u63A5\u91CD\u53D1",
  HOST_CAPABILITY_MISSING: "\u5BBF\u4E3B\u80FD\u529B\u7F3A\u5931\uFF0C\u5DF2\u6309\u964D\u7EA7\u65B9\u5F0F\u5904\u7406\uFF1B\u8BE6\u60C5\u89C1\u8BCA\u65AD\u9875"
};
function nextStepFor(code) {
  return NEXT_STEP[code] ?? "\u8054\u7CFB\u7BA1\u7406\u5458";
}
function toReceiptError(error) {
  if (error instanceof HamsError) {
    return {
      code: error.code,
      message: error.message,
      nextStep: error.nextStep ?? nextStepFor(error.code),
      detail: error.detail
    };
  }
  return {
    code: "STATE_INVALID",
    message: error instanceof Error ? error.message : String(error),
    nextStep: nextStepFor("STATE_INVALID")
  };
}
function rejectedReceipt(correlationId, error) {
  return {
    ok: false,
    status: "rejected",
    auditId: "",
    correlationId,
    error: toReceiptError(error)
  };
}
var PayloadError = class extends HamsError {
  constructor(message) {
    super("STATE_INVALID", message, { nextStep: "\u68C0\u67E5\u8BF7\u6C42\u53C2\u6570\u540E\u91CD\u8BD5" });
    this.name = "PayloadError";
  }
};
function asObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PayloadError(`${field} \u5FC5\u987B\u662F\u5BF9\u8C61`);
  }
  return value;
}
function asString(value, field, options = {}) {
  if (typeof value !== "string") throw new PayloadError(`${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  if (!options.allowEmpty && value.trim().length === 0) throw new PayloadError(`${field} \u4E0D\u80FD\u4E3A\u7A7A`);
  return value;
}
function optionalString(value, field) {
  if (value === void 0 || value === null) return void 0;
  return asString(value, field, { allowEmpty: true });
}
function asNumber(value, field) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new PayloadError(`${field} \u5FC5\u987B\u662F\u6570\u5B57`);
  return parsed;
}
function optionalNumber(value, field) {
  if (value === void 0 || value === null) return void 0;
  return asNumber(value, field);
}
function requireEnvelope(raw, options) {
  const body = asObject(raw, "\u8BF7\u6C42\u4F53");
  const commandId = asString(body.commandId, "commandId");
  const idempotencyKey = optionalString(body.idempotencyKey, "idempotencyKey");
  if (options.write && !idempotencyKey) {
    throw new PayloadError(`\u5199\u547D\u4EE4\u5FC5\u987B\u5E26 idempotencyKey\uFF08command ${commandId}\uFF09`);
  }
  const envelope = {
    commandId,
    idempotencyKey,
    objectId: optionalString(body.objectId, "objectId"),
    expectedRevision: optionalNumber(body.expectedRevision, "expectedRevision"),
    expectedEpoch: optionalNumber(body.expectedEpoch, "expectedEpoch"),
    payload: body.payload
  };
  return envelope;
}
function toCommandContext(input) {
  return {
    principalId: input.principalId,
    channel: input.channel,
    correlationId: input.correlationId,
    idempotencyKey: input.envelope.idempotencyKey,
    expectedRevision: input.envelope.expectedRevision,
    authSubject: input.authSubject,
    hostPreset: input.hostPreset,
    onBehalfOf: input.onBehalfOf
  };
}

// src/service/deliverables.ts
import { existsSync as existsSync4, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync as statSync3 } from "node:fs";
import path5 from "node:path";
var MAX_FILES = 500;
var MAX_DEPTH = 6;
var MAX_PREVIEW_BYTES = 256 * 1024;
var SKIP_DIRS2 = /* @__PURE__ */ new Set(["node_modules", ".git", ".cache", ".venv", "__pycache__"]);
function workItemsOfProject(db, projectId) {
  return db.prepare("SELECT id, title, status FROM work_item WHERE project_id = ? ORDER BY updated_at DESC").all(projectId);
}
function memberNames(db) {
  const rows = db.prepare("SELECT id, name FROM member WHERE kind = 'bot'").all();
  return new Map(rows.map((row) => [row.id, row.name]));
}
function walk(root, relRoot, onFile, budget, depth = 0) {
  if (budget.left <= 0 || depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync3(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    if (entry.isSymbolicLink()) continue;
    const full = path5.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS2.has(entry.name)) continue;
      walk(full, `${relRoot}/${entry.name}`, onFile, budget, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = statSync3(full);
    } catch {
      continue;
    }
    budget.left -= 1;
    onFile(`${relRoot}/${entry.name}`, stat.size, stat.mtimeMs);
  }
}
function listDeliverables(options) {
  const dataDir = path5.resolve(options.dataDir);
  const botsRoot = path5.join(dataDir, "bots");
  const workItems = workItemsOfProject(options.db, options.projectId);
  if (!existsSync4(botsRoot)) return { items: [], truncated: false, workItems: workItems.length };
  const names = memberNames(options.db);
  const budget = { left: Math.min(Math.max(options.limit ?? MAX_FILES, 1), MAX_FILES) };
  const items = [];
  let truncated = false;
  for (const memberId of readdirSync3(botsRoot)) {
    const memberDir = path5.join(botsRoot, memberId);
    let isDir = false;
    try {
      isDir = statSync3(memberDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    for (const item of workItems) {
      const workDir = path5.join(memberDir, "work", item.id);
      if (!existsSync4(workDir)) continue;
      const relBase = `bots/${memberId}/work/${item.id}`;
      walk(workDir, relBase, (relPath, size, mtime) => {
        items.push({
          relPath,
          projectId: options.projectId,
          workItemId: item.id,
          workItemTitle: item.title,
          workItemStatus: item.status,
          memberId,
          memberName: names.get(memberId) || memberId,
          source: "work",
          label: item.title,
          name: path5.posix.basename(relPath),
          size,
          mtime: Math.round(mtime)
        });
      }, budget);
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    const chatsDir = path5.join(memberDir, "chats");
    if (!existsSync4(chatsDir)) continue;
    for (const chatEntry of readdirSync3(chatsDir)) {
      const isProjectChat = chatEntry === `chat-project-${options.projectId}` || chatEntry.startsWith(`chat-group-${options.projectId}-`);
      if (!isProjectChat) continue;
      const chatDir = path5.join(chatsDir, chatEntry);
      let isDir2 = false;
      try {
        isDir2 = statSync3(chatDir).isDirectory();
      } catch {
        isDir2 = false;
      }
      if (!isDir2) continue;
      const relBase = `bots/${memberId}/chats/${chatEntry}`;
      walk(chatDir, relBase, (relPath, size, mtime) => {
        items.push({
          relPath,
          projectId: options.projectId,
          workItemId: "",
          workItemTitle: "",
          workItemStatus: "",
          memberId,
          memberName: names.get(memberId) || memberId,
          source: "chat",
          label: "\u9879\u76EE\u7FA4\u804A",
          name: path5.posix.basename(relPath),
          size,
          mtime: Math.round(mtime)
        });
      }, budget);
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items, truncated, workItems: workItems.length };
}
function readDeliverable(options) {
  const dataDir = path5.resolve(options.dataDir);
  const botsRoot = path5.join(dataDir, "bots");
  const raw = String(options.relPath || "").trim();
  if (!raw) throw new HamsError("STATE_INVALID", "\u7F3A\u5C11\u6587\u4EF6\u8DEF\u5F84");
  if (path5.isAbsolute(raw)) throw new HamsError("POLICY_DENIED", "\u53EA\u63A5\u53D7\u9879\u76EE\u5DE5\u4F5C\u533A\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84");
  const resolved = path5.resolve(dataDir, raw);
  const base = botsRoot + path5.sep;
  if (!resolved.startsWith(base)) throw new HamsError("POLICY_DENIED", "\u53EA\u5141\u8BB8\u770B bot \u5DE5\u4F5C\u533A\u91CC\u7684\u6587\u4EF6");
  const parts = path5.relative(dataDir, resolved).split(path5.sep);
  if (parts.length < 5 || parts[0] !== "bots") {
    throw new HamsError("POLICY_DENIED", "\u8DEF\u5F84\u4E0D\u5728\u4EA4\u4ED8\u7269\u76EE\u5F55\u7EA6\u5B9A\u5185");
  }
  if (parts[2] === "work") {
    const workItemId = parts[3];
    const owned = options.db.prepare("SELECT 1 AS ok FROM work_item WHERE id = ? AND project_id = ?").get(workItemId, options.projectId);
    if (!owned) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u9879\u76EE\u7684\u5DE5\u4F5C\u9879");
  } else if (parts[2] === "chats") {
    const chatKey = parts[3];
    const isProjectChat = chatKey === `chat-project-${options.projectId}` || chatKey.startsWith(`chat-group-${options.projectId}-`);
    if (!isProjectChat) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D\u9879\u76EE\u7684\u7FA4\u804A\u5DE5\u4F5C\u533A");
  } else {
    throw new HamsError("POLICY_DENIED", "\u8DEF\u5F84\u4E0D\u5728\u4EA4\u4ED8\u7269\u76EE\u5F55\u7EA6\u5B9A\u5185");
  }
  let stat;
  try {
    stat = statSync3(resolved);
  } catch {
    throw new HamsError("STATE_INVALID", "\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u5DF2\u79FB\u8D70");
  }
  if (!stat.isFile()) throw new HamsError("STATE_INVALID", "\u4E0D\u662F\u666E\u901A\u6587\u4EF6");
  const readBytes = Math.min(stat.size, MAX_PREVIEW_BYTES);
  const buffer = readFileSync3(resolved).subarray(0, readBytes);
  const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
  return {
    relPath: path5.relative(dataDir, resolved).split(path5.sep).join("/"),
    name: path5.posix.basename(resolved),
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    binary,
    truncated: stat.size > readBytes,
    content: binary ? "" : buffer.toString("utf8")
  };
}

// src/http/handler.ts
var API_PREFIX = "/hams/api/v1/";
var DEFAULT_MAX_BODY = 256 * 1024;
function payloadOf(envelope) {
  return envelope.payload === void 0 ? {} : asObject(envelope.payload, "payload");
}
function idOf(envelope, payload, field = "objectId") {
  const fromEnvelope = envelope.objectId;
  if (fromEnvelope) return fromEnvelope;
  return asString(payload[field], field);
}
function metricListOf(payload, lenient = false) {
  const list = payload.metrics;
  if (list === void 0) return void 0;
  if (!Array.isArray(list)) throw new HamsError("STATE_INVALID", "payload.metrics \u5FC5\u987B\u662F\u6570\u7EC4");
  if (!lenient) return list;
  return list.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}
function ok(data, correlationId) {
  return { ok: true, data, correlationId };
}
function stringArray(value, field) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new HamsError("STATE_INVALID", `${field} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4`);
  return value.map((item, index) => asString(item, `${field}[${index}]`));
}
var ROUTES = new Map([
  [
    "session/whoami",
    {
      write: false,
      handle: (service, ctx) => ok(service.whoami(ctx), ctx.correlationId)
    }
  ],
  [
    "ops/health",
    {
      write: false,
      handle: (service, ctx) => ok(service.health(ctx), ctx.correlationId)
    }
  ],
  [
    "overview/get",
    {
      write: false,
      handle: (service, ctx) => ok(service.overview(ctx), ctx.correlationId)
    }
  ],
  // ── 对话：单聊（智能体）/ 群聊（项目）──────────────────────────────────
  // 消息正文留在宿主会话里，这里只读；线程指针存在 hams_meta，不新建表。
  [
    "chat/open",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1", { nextStep: "\u91CD\u542F DSH \u8BA9\u63D2\u4EF6\u63A5\u4E0A agents \u670D\u52A1" });
        const payload = payloadOf(envelope);
        const kind = asString(payload.kind, "payload.kind");
        if (kind !== "member" && kind !== "project") throw new HamsError("STATE_INVALID", "kind \u53EA\u80FD\u662F member \u6216 project");
        return ok(await extras.chat.open(ctx, { kind, targetId: asString(payload.targetId, "payload.targetId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/send",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1", { nextStep: "\u91CD\u542F DSH \u8BA9\u63D2\u4EF6\u63A5\u4E0A agents \u670D\u52A1" });
        const payload = payloadOf(envelope);
        const kind = asString(payload.kind, "payload.kind");
        if (kind !== "member" && kind !== "project") throw new HamsError("STATE_INVALID", "kind \u53EA\u80FD\u662F member \u6216 project");
        return ok(await extras.chat.send(ctx, { kind, targetId: asString(payload.targetId, "payload.targetId"), text: asString(payload.text, "payload.text") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/messages",
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ thread: null, messages: [], running: false, available: false, reason: "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1" }, ctx.correlationId);
        const payload = payloadOf(envelope);
        const kind = asString(payload.kind, "payload.kind");
        if (kind !== "member" && kind !== "project") throw new HamsError("STATE_INVALID", "kind \u53EA\u80FD\u662F member \u6216 project");
        return ok(await extras.chat.read(ctx, { kind, targetId: asString(payload.targetId, "payload.targetId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/stop",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1", { nextStep: "\u91CD\u542F DSH \u8BA9\u63D2\u4EF6\u63A5\u4E0A agents \u670D\u52A1" });
        const payload = payloadOf(envelope);
        const kind = asString(payload.kind, "payload.kind");
        if (kind !== "member" && kind !== "project") throw new HamsError("STATE_INVALID", "kind \u53EA\u80FD\u662F member \u6216 project");
        return ok(await extras.chat.stop(ctx, { kind, targetId: asString(payload.targetId, "payload.targetId") }), ctx.correlationId);
      }
    }
  ],
  [
    "project/deliverables",
    {
      write: false,
      handle: (service, ctx, envelope, extras) => {
        if (!extras.deliverables) return ok({ items: [], truncated: false, workItems: 0 }, ctx.correlationId);
        const payload = payloadOf(envelope);
        return ok(
          listDeliverables({
            db: extras.deliverables.db,
            dataDir: extras.deliverables.dataDir,
            projectId: asString(payload.projectId, "payload.projectId")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "project/deliverable",
    {
      write: false,
      handle: (service, ctx, envelope, extras) => {
        if (!extras.deliverables) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u4EA4\u4ED8\u7269\u76EE\u5F55\uFF0C\u65E0\u6CD5\u9884\u89C8\u6587\u4EF6");
        const payload = payloadOf(envelope);
        return ok(
          readDeliverable({
            db: extras.deliverables.db,
            dataDir: extras.deliverables.dataDir,
            projectId: asString(payload.projectId, "payload.projectId"),
            relPath: asString(payload.path, "payload.path")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "chat/team",
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ coordinator: null, members: [] }, ctx.correlationId);
        return ok(await extras.chat.team(ctx, { projectId: asString(payloadOf(envelope).projectId, "payload.projectId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/team/add",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1");
        const payload = payloadOf(envelope);
        return ok(extras.chat.addParticipant(ctx, { projectId: asString(payload.projectId, "payload.projectId"), memberId: asString(payload.memberId, "payload.memberId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/team/remove",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1");
        const payload = payloadOf(envelope);
        return ok(extras.chat.removeParticipant(ctx, { projectId: asString(payload.projectId, "payload.projectId"), memberId: asString(payload.memberId, "payload.memberId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/team/spawn",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1");
        const payload = payloadOf(envelope);
        return ok(extras.chat.spawnTempBot(ctx, { projectId: asString(payload.projectId, "payload.projectId"), name: asString(payload.name, "payload.name"), brief: optionalString(payload.brief, "payload.brief") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/group/messages",
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ messages: [], members: [], coordinator: null, running: false, available: false, reason: "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1" }, ctx.correlationId);
        return ok(await extras.chat.groupRead(ctx, { projectId: asString(payloadOf(envelope).projectId, "payload.projectId") }), ctx.correlationId);
      }
    }
  ],
  [
    "chat/group/send",
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1");
        const payload = payloadOf(envelope);
        return ok(await extras.chat.groupSend(ctx, { projectId: asString(payload.projectId, "payload.projectId"), text: asString(payload.text, "payload.text") }), ctx.correlationId);
      }
    }
  ],
  [
    "host/catalog",
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => ok({
        available: Boolean(extras.chat && extras.chat.available),
        reason: extras.chat ? extras.chat.reason : "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1",
        presets: extras.chat ? await extras.chat.presets() : [],
        models: extras.chat ? await extras.chat.models() : []
      }, ctx.correlationId)
    }
  ],
  [
    "changes/since",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.changesSince(ctx, {
            cursor: payload.cursor === void 0 ? void 0 : asNumber(payload.cursor, "payload.cursor"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "proposal/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listProposals(ctx, {
            deciderId: optionalString(payload.deciderId, "payload.deciderId"),
            status: optionalString(payload.status, "payload.status"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "workItem/create",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.createWorkItem(ctx, {
          domain: asString(payload.domain, "payload.domain"),
          category: asString(payload.category, "payload.category"),
          title: asString(payload.title, "payload.title"),
          ownerHumanId: optionalString(payload.ownerHumanId, "payload.ownerHumanId"),
          projectId: optionalString(payload.projectId, "payload.projectId"),
          templateVersionId: optionalString(payload.templateVersionId, "payload.templateVersionId"),
          assetId: optionalString(payload.assetId, "payload.assetId"),
          dedupeKey: optionalString(payload.dedupeKey, "payload.dedupeKey"),
          priority: payload.priority === void 0 ? void 0 : asNumber(payload.priority, "payload.priority"),
          dueAt: payload.dueAt === void 0 ? void 0 : asNumber(payload.dueAt, "payload.dueAt")
        });
      }
    }
  ],
  [
    "workItem/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listWorkItems(ctx, {
            status: optionalString(payload.status, "payload.status"),
            assigneeId: optionalString(payload.assigneeId, "payload.assigneeId"),
            ownerId: optionalString(payload.ownerId, "payload.ownerId"),
            projectId: optionalString(payload.projectId, "payload.projectId"),
            domain: optionalString(payload.domain, "payload.domain"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "workItem/get",
    {
      write: false,
      handle: (service, ctx, envelope) => ok(service.getWorkItem(ctx, idOf(envelope, payloadOf(envelope))), ctx.correlationId)
    }
  ],
  [
    "check/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(service.listChecks(ctx, asString(payload.workItemId, "payload.workItemId")), ctx.correlationId);
      }
    }
  ],
  [
    "template/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listTemplates(ctx, { domain: optionalString(payload.domain, "payload.domain") }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "approval/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listApprovals(ctx, {
            approverId: optionalString(payload.approverId, "payload.approverId"),
            status: optionalString(payload.status, "payload.status")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "workItem/assign",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.assignWorkItem(ctx, {
          workItemId: idOf(envelope, payload),
          memberId: asString(payload.memberId ?? payload.assigneeId, "payload.memberId")
        });
      }
    }
  ],
  [
    "workItem/accept",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.accept(ctx, {
          workItemId: idOf(envelope, payload),
          note: optionalString(payload.note, "payload.note")
        });
      }
    }
  ],
  ...[
    ["workItem/pause", "pause"],
    ["workItem/resume", "resume"],
    ["workItem/cancel", "cancel"],
    ["workItem/reopen", "reopen"],
    ["workItem/retry", "retry"]
  ].map(([path11, method]) => [
    path11,
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        const fn = service[method].bind(service);
        return fn(ctx, {
          workItemId: idOf(envelope, payload),
          reason: optionalString(payload.reason, "payload.reason")
        });
      }
    }
  ]),
  ["workItem/rotateThread", { write: true, handle: (service, ctx, envelope) => {
    const p = payloadOf(envelope);
    return service.rotateThread(ctx, { workItemId: idOf(envelope, p), sessionId: asString(p.sessionId, "sessionId"), reason: optionalString(p.reason, "reason") });
  } }],
  [
    "workItem/addEvidence",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.appendEvidence(ctx, {
          workItemId: idOf(envelope, payload),
          kind: asString(payload.kind, "payload.kind"),
          ref: asString(payload.ref, "payload.ref"),
          observedAt: asNumber(payload.observedAt, "payload.observedAt"),
          contentHash: optionalString(payload.contentHash, "payload.contentHash"),
          source: optionalString(payload.source, "payload.source"),
          runId: optionalString(payload.runId, "payload.runId"),
          onBehalfOf: optionalString(payload.onBehalfOf, "payload.onBehalfOf"),
          supersedesId: optionalString(payload.supersedesId, "payload.supersedesId")
        });
      }
    }
  ],
  [
    "workItem/reportBlocker",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.reportBlocker(ctx, {
          workItemId: idOf(envelope, payload),
          category: asString(payload.category, "payload.category"),
          note: asString(payload.note, "payload.note", { allowEmpty: true })
        });
      }
    }
  ],
  [
    "workItem/unblock",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        const to = optionalString(payload.to, "payload.to");
        if (to !== void 0 && to !== "ready" && to !== "active") {
          throw new HamsError("STATE_INVALID", "payload.to \u53EA\u80FD\u662F ready \u6216 active");
        }
        return service.unblock(ctx, { workItemId: idOf(envelope, payload), to });
      }
    }
  ],
  [
    "workItem/requestClosure",
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.requestClosure(ctx, {
          workItemId: idOf(envelope, payload),
          reason: asString(payload.reason, "payload.reason")
        });
      }
    }
  ],
  [
    "approval/decide",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        const decision = asString(payload.decision, "payload.decision");
        if (decision !== "approve" && decision !== "reject" && decision !== "return") {
          throw new HamsError("STATE_INVALID", "payload.decision \u53EA\u80FD\u662F approve / reject / return");
        }
        return service.decideApproval(ctx, {
          approvalId: idOf(envelope, payload, "approvalId"),
          decision,
          note: optionalString(payload.note, "payload.note")
        });
      }
    }
  ],
  [
    "proposal/decide",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        const decision = asString(payload.decision, "payload.decision");
        if (decision !== "accept" && decision !== "reject") {
          throw new HamsError("STATE_INVALID", "payload.decision \u53EA\u80FD\u662F accept / reject");
        }
        const workItemRaw = payload.workItem === void 0 ? void 0 : asObject(payload.workItem, "payload.workItem");
        return service.decideProposal(ctx, {
          proposalId: idOf(envelope, payload, "proposalId"),
          decision,
          note: asString(payload.note, "payload.note", { allowEmpty: true }),
          workItem: workItemRaw ? {
            domain: asString(workItemRaw.domain, "payload.workItem.domain"),
            category: asString(workItemRaw.category, "payload.workItem.category"),
            title: asString(workItemRaw.title, "payload.workItem.title"),
            ownerHumanId: asString(workItemRaw.ownerHumanId, "payload.workItem.ownerHumanId"),
            projectId: optionalString(workItemRaw.projectId, "payload.workItem.projectId"),
            templateVersionId: optionalString(workItemRaw.templateVersionId, "payload.workItem.templateVersionId"),
            assetId: optionalString(workItemRaw.assetId, "payload.workItem.assetId"),
            dueAt: workItemRaw.dueAt === void 0 ? void 0 : asNumber(workItemRaw.dueAt, "payload.workItem.dueAt")
          } : void 0
        });
      }
    }
  ],
  [
    "check/evaluate",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.evaluateCheck(ctx, {
          checkId: idOf(envelope, payload, "checkId")
        });
      }
    }
  ],
  // ───────────────────────── 项目（M6） ─────────────────────────
  [
    "project/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listProjects(ctx, {
            status: optionalString(payload.status, "payload.status"),
            type: optionalString(payload.type, "payload.type"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "project/get",
    {
      write: false,
      handle: (service, ctx, envelope) => ok(
        service.getProjectDetail(ctx, idOf(envelope, payloadOf(envelope), "projectId")),
        ctx.correlationId
      )
    }
  ],
  [
    "project/create",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        const metricList = payload.metrics === void 0 ? void 0 : payload.metrics;
        if (metricList !== void 0 && !Array.isArray(metricList)) {
          throw new HamsError("STATE_INVALID", "payload.metrics \u5FC5\u987B\u662F\u6570\u7EC4");
        }
        const metrics = metricList?.map((item, index) => {
          const metric = asObject(item, `payload.metrics[${index}]`);
          return {
            name: asString(metric.name, `payload.metrics[${index}].name`),
            direction: asString(metric.direction, `payload.metrics[${index}].direction`),
            targetValue: metric.targetValue === void 0 || metric.targetValue === null ? null : asNumber(metric.targetValue, `payload.metrics[${index}].targetValue`),
            targetMax: metric.targetMax === void 0 || metric.targetMax === null ? null : asNumber(metric.targetMax, `payload.metrics[${index}].targetMax`),
            unit: optionalString(metric.unit, `payload.metrics[${index}].unit`),
            windowKind: asString(metric.windowKind, `payload.metrics[${index}].windowKind`),
            definitionText: optionalString(metric.definitionText, `payload.metrics[${index}].definitionText`),
            sourceKind: optionalString(metric.sourceKind, `payload.metrics[${index}].sourceKind`),
            calculatorKey: optionalString(metric.calculatorKey, "calculatorKey"),
            calculatorParams: metric.calculatorParams === void 0 ? void 0 : asObject(metric.calculatorParams, "calculatorParams"),
            sourceRef: optionalString(metric.sourceRef, "sourceRef")
          };
        });
        return service.createProject(ctx, {
          name: asString(payload.name, "payload.name"),
          type: asString(payload.type, "payload.type"),
          goalText: asString(payload.goalText, "payload.goalText", { allowEmpty: true }),
          ownerHumanId: optionalString(payload.ownerHumanId, "payload.ownerHumanId"),
          coordinatorId: payload.coordinatorId === null ? null : optionalString(payload.coordinatorId, "payload.coordinatorId"),
          metrics,
          publish: payload.publish === void 0 ? void 0 : payload.publish === true
        });
      }
    }
  ],
  [
    "project/saveDraft",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.saveProjectDraft(ctx, {
          projectId: optionalString(payload.projectId, "payload.projectId"),
          name: asString(payload.name, "payload.name"),
          type: asString(payload.type, "payload.type"),
          goalText: asString(payload.goalText ?? "", "payload.goalText", { allowEmpty: true }),
          coordinatorId: payload.coordinatorId === null ? null : optionalString(payload.coordinatorId, "payload.coordinatorId"),
          metrics: metricListOf(payload, true),
          step: payload.step === void 0 ? void 0 : asNumber(payload.step, "payload.step")
        });
      }
    }
  ],
  [
    "project/delete",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.deleteProject(ctx, {
          projectId: idOf(envelope, payload, "projectId"),
          reason: optionalString(payload.reason, "payload.reason")
        });
      }
    }
  ],
  [
    "project/status",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.updateProjectStatus(ctx, {
          projectId: idOf(envelope, payload, "projectId"),
          status: asString(payload.status, "payload.status"),
          reason: optionalString(payload.reason, "payload.reason")
        });
      }
    }
  ],
  [
    "project/memory/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listProjectMemories(ctx, {
            projectId: asString(payload.projectId, "payload.projectId"),
            status: optionalString(payload.status, "payload.status"),
            kind: optionalString(payload.kind, "payload.kind"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "project/memory/create",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.createProjectMemory(ctx, {
          projectId: idOf(envelope, payload, "projectId"),
          kind: asString(payload.kind, "payload.kind"),
          title: asString(payload.title, "payload.title"),
          body: asString(payload.body, "payload.body"),
          memberId: optionalString(payload.memberId, "payload.memberId")
        });
      }
    }
  ],
  [
    "project/memory/update",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.updateProjectMemory(ctx, {
          memoryId: idOf(envelope, payload, "memoryId"),
          title: optionalString(payload.title, "payload.title"),
          body: optionalString(payload.body, "payload.body"),
          status: optionalString(payload.status, "payload.status")
        });
      }
    }
  ],
  [
    "project/recordMetric",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.recordMetric(ctx, {
          projectId: idOf(envelope, payload, "projectId"),
          metricId: asString(payload.metricId, "payload.metricId"),
          value: payload.value === void 0 || payload.value === null ? null : asNumber(payload.value, "payload.value"),
          observedAt: payload.observedAt === void 0 ? void 0 : asNumber(payload.observedAt, "payload.observedAt"),
          windowStart: payload.windowStart === void 0 ? void 0 : asNumber(payload.windowStart, "payload.windowStart"),
          windowEnd: payload.windowEnd === void 0 ? void 0 : asNumber(payload.windowEnd, "payload.windowEnd"),
          sourceRef: optionalString(payload.sourceRef, "payload.sourceRef")
        });
      }
    }
  ],
  ...[
    ["project/publishTarget", "publishProjectTarget"],
    ["project/createPhase", "createProjectPhase"],
    ["project/updatePhase", "updateProjectPhase"],
    ["project/confirmPhase", "confirmProjectPhase"],
    ["project/submitTargetCheck", "submitProjectTargetCheck"],
    ["project/updateTarget", "updateProjectTarget"],
    ["project/addTarget", "addProjectTarget"],
    ["project/createReview", "createProjectReview"],
    ["project/confirmReview", "confirmProjectReview"]
  ].map(([path11, method]) => [path11, { write: true, handle: (service, ctx, envelope) => {
    const payload = payloadOf(envelope);
    return service[method].call(service, ctx, { ...payload, projectId: idOf(envelope, payload, "projectId") });
  } }]),
  ["project/tryMetric", { write: false, handle: (service, ctx, envelope) => {
    const p = payloadOf(envelope);
    return ok(service.tryProjectMetric(ctx, { projectId: optionalString(p.projectId, "projectId"), metric: asObject(p.metric, "metric") }), ctx.correlationId);
  } }],
  ["member/publishConfig", { write: true, handle: (service, ctx, envelope) => {
    const p = payloadOf(envelope);
    return service.publishMemberConfig(ctx, { ...p, memberId: idOf(envelope, p, "memberId") });
  } }],
  // ───────────────────────── 人机成员（M6） ─────────────────────────
  [
    "member/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listMembers(ctx, {
            kind: optionalString(payload.kind, "payload.kind"),
            status: optionalString(payload.status, "payload.status"),
            projectId: optionalString(payload.projectId, "payload.projectId"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "member/get",
    {
      write: false,
      handle: (service, ctx, envelope) => ok(service.getMemberDetail(ctx, idOf(envelope, payloadOf(envelope), "memberId")), ctx.correlationId)
    }
  ],
  [
    "position/list",
    {
      write: false,
      handle: (service, ctx) => ok(service.listPositions(ctx), ctx.correlationId)
    }
  ],
  [
    "member/create",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.createMember(ctx, {
          kind: asString(payload.kind, "payload.kind"),
          name: asString(payload.name, "payload.name"),
          role: optionalString(payload.role, "payload.role"),
          domain: optionalString(payload.domain, "payload.domain"),
          responsibility: optionalString(payload.responsibility, "payload.responsibility"),
          positionId: optionalString(payload.positionId, "payload.positionId"),
          ownerHumanId: optionalString(payload.ownerHumanId, "payload.ownerHumanId"),
          agentPreset: optionalString(payload.agentPreset, "payload.agentPreset"),
          model: optionalString(payload.model, "payload.model"),
          prompt: optionalString(payload.prompt, "payload.prompt"),
          capabilities: stringArray(payload.capabilities, "payload.capabilities"),
          scope: optionalString(payload.scope, "payload.scope")
        });
      }
    }
  ],
  [
    "member/status",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.updateMemberStatus(ctx, {
          memberId: idOf(envelope, payload, "memberId"),
          status: asString(payload.status, "payload.status")
        });
      }
    }
  ],
  // ───────────────────────── 知识（M6） ─────────────────────────
  [
    "knowledge/list",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.listKnowledge(ctx, {
            kind: optionalString(payload.kind, "payload.kind"),
            q: optionalString(payload.q, "payload.q"),
            limit: payload.limit === void 0 ? void 0 : asNumber(payload.limit, "payload.limit")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "knowledge/get",
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return ok(
          service.getKnowledge(ctx, {
            kind: asString(payload.kind, "payload.kind"),
            id: idOf(envelope, payload, "id")
          }),
          ctx.correlationId
        );
      }
    }
  ],
  [
    "knowledge/sync",
    {
      write: true,
      handle: (service, ctx) => service.syncKnowledge(ctx)
    }
  ],
  [
    "knowledge/createDoc",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.createKnowledgeDoc(ctx, {
          title: asString(payload.title, "payload.title"),
          body: asString(payload.body, "payload.body", { allowEmpty: true }),
          status: optionalString(payload.status, "payload.status")
        });
      }
    }
  ],
  [
    "knowledge/updateDoc",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.updateKnowledgeDoc(ctx, {
          docId: idOf(envelope, payload, "docId"),
          title: optionalString(payload.title, "payload.title"),
          body: asString(payload.body, "payload.body", { allowEmpty: true }),
          expectedRevision: payload.expectedRevision === void 0 ? void 0 : asNumber(payload.expectedRevision, "payload.expectedRevision")
        });
      }
    }
  ],
  [
    "knowledge/publishDoc",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.publishKnowledgeDoc(ctx, { docId: idOf(envelope, payload, "docId") });
      }
    }
  ],
  [
    "knowledge/importDocs",
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope);
        return service.importKnowledgeDocs(ctx, {
          dir: asString(payload.dir, "payload.dir"),
          recursive: payload.recursive === void 0 ? void 0 : payload.recursive === true,
          maxFiles: payload.maxFiles === void 0 ? void 0 : asNumber(payload.maxFiles, "payload.maxFiles")
        });
      }
    }
  ]
]);
var ROUTE_PATHS = [...ROUTES.keys()].sort();
function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body)
  };
}
function transportError(status, correlationId, message, code = "STATE_INVALID") {
  const body = {
    ok: false,
    correlationId,
    error: { code, message, nextStep: "\u68C0\u67E5\u8BF7\u6C42\u8DEF\u5F84\u4E0E\u8BF7\u6C42\u5934\u540E\u91CD\u8BD5" }
  };
  return json(status, body);
}
function authError(correlationId, auth) {
  const status = auth.reason === "UNAUTHORIZED" ? 401 : 403;
  return json(status, {
    ok: false,
    correlationId,
    error: {
      code: "POLICY_DENIED",
      message: auth.message,
      nextStep: auth.nextStep ?? (status === 401 ? "\u91CD\u65B0\u6253\u5F00 dsh \u6253\u5370\u7684\u5E26 ?token= \u7684\u5730\u5740\uFF08\u6216\u5237\u65B0\u9875\u9762\uFF09\u540E\u518D\u8BD5" : "\u786E\u8BA4\u8BF7\u6C42\u6765\u81EA\u672C\u673A\u9762\u677F\u540E\u91CD\u8BD5")
    }
  });
}
var counter = 0;
function createHamsHttpHandler(deps) {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const newCorrelationId = deps.correlationId ?? (() => `http-${Date.now().toString(36)}-${counter += 1}`);
  const finish = (routeKey, result, correlationId) => {
    if (routeKey === "ops/health" && result.ok && "data" in result) {
      return json(200, { ...result, data: { ...result.data, readOnly: deps.readOnly === true } });
    }
    return json(200, result);
  };
  return function handle(request) {
    const correlationId = newCorrelationId();
    if (request.method.toUpperCase() !== "POST") {
      return transportError(405, correlationId, "\u53EA\u63A5\u53D7 POST");
    }
    if (!request.path.startsWith(API_PREFIX)) {
      return transportError(404, correlationId, `\u672A\u77E5\u63A5\u53E3\uFF1A${request.path}`);
    }
    const routeKey = request.path.slice(API_PREFIX.length);
    const route = ROUTES.get(routeKey);
    if (!route) return transportError(404, correlationId, `\u672A\u77E5\u547D\u4EE4\uFF1A${routeKey}`);
    if (Buffer.byteLength(request.body, "utf8") > maxBody) {
      return transportError(413, correlationId, "\u8BF7\u6C42\u4F53\u8FC7\u5927");
    }
    const auth = deps.authenticate(request);
    if (!auth.ok) {
      return authError(correlationId, auth);
    }
    let rawBody;
    try {
      rawBody = JSON.parse(request.body || "{}");
    } catch {
      return transportError(400, correlationId, "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    let envelope;
    try {
      envelope = requireEnvelope(rawBody, { write: route.write, correlationId });
    } catch (error) {
      return json(200, rejectedReceipt(correlationId, error));
    }
    const ctx = toCommandContext({
      principalId: auth.principalId,
      channel: "ui",
      correlationId,
      envelope,
      authSubject: auth.authSubject,
      hostPreset: auth.hostPreset,
      onBehalfOf: auth.onBehalfOf
    });
    try {
      if (deps.readOnly && route.write) {
        throw new HamsError("HOST_CAPABILITY_MISSING", "\u53E6\u4E00\u5B9E\u4F8B\u6301\u6709\u5199\u9501\uFF0C\u5F53\u524D\u5B9E\u4F8B\u4E3A\u53EA\u8BFB\u89C6\u56FE", {
          nextStep: "\u5173\u95ED\u53E6\u4E00\u5B9E\u4F8B\uFF0C\u6216\u7B49\u5B83\u91CA\u653E\u5199\u9501\u540E\u91CD\u8BD5"
        });
      }
      const principal = deps.service.whoami(ctx).principal;
      if (principal.kind === "bot") {
        return json(200, rejectedReceipt(correlationId, new HamsError("POLICY_DENIED", "bot \u53EA\u80FD\u901A\u8FC7\u5DE5\u5177\u901A\u9053\u52A8\u4F5C\uFF0C\u4E0D\u80FD\u8C03\u7528 UI \u63A5\u53E3")));
      }
      const result = route.handle(deps.service, ctx, envelope, { chat: deps.chat });
      if (result && typeof result.then === "function") {
        return result.then((settled) => finish(routeKey, settled, correlationId)).catch((error) => json(200, rejectedReceipt(correlationId, error)));
      }
      return finish(routeKey, result, correlationId);
    } catch (error) {
      return json(200, rejectedReceipt(correlationId, error));
    }
  };
}

// src/service/tools.ts
function resolveThreadIdentity(db, sessionId) {
  const row = db.prepare(
    `SELECT id, work_item_id, member_id, generation, status
         FROM work_item_thread WHERE session_id = ?
        ORDER BY generation DESC LIMIT 1`
  ).get(sessionId);
  if (!row) return null;
  return {
    threadId: row.id,
    workItemId: row.work_item_id,
    memberId: row.member_id,
    generation: row.generation,
    status: row.status
  };
}
function fail(error) {
  if (error instanceof HamsError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        nextStep: error.nextStep ?? nextStepFor(error.code),
        detail: error.detail
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "STATE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      nextStep: nextStepFor("STATE_INVALID")
    }
  };
}
function assertNoIdentityArgs(args) {
  for (const field of ["memberId", "member_id", "principalId", "principal_id", "actorId", "actor_id"]) {
    if (field in args) {
      throw new HamsError("POLICY_DENIED", "\u8EAB\u4EFD\u7531\u670D\u52A1\u7AEF\u4ECE\u4F1A\u8BDD\u89E3\u6790\uFF0C\u53C2\u6570\u91CC\u4E0D\u63A5\u53D7\u4EFB\u4F55\u8EAB\u4EFD\u5B57\u6BB5");
    }
  }
}
function createHamsTools(options) {
  const { service, db } = options;
  const resolve = options.resolveThread ?? resolveThreadIdentity;
  let counter2 = 0;
  function identity(exec) {
    const source = memberIdentity(exec);
    if (!source.thread) {
      throw new HamsError("POLICY_DENIED", `\u8FD9\u4E2A\u64CD\u4F5C\u8981\u5728\u5DE5\u4F5C\u9879\u4F1A\u8BDD\u91CC\u505A\uFF0C\u5F53\u524D\u662F\u5BF9\u8BDD\u4F1A\u8BDD\uFF1A${exec.sessionId}`, {
        nextStep: "\u628A\u8FD9\u4E2A\u52A8\u4F5C\u4EA4\u7ED9\u5DE5\u4F5C\u9879\u91CC\u7684\u8FD0\u884C\uFF1B\u5BF9\u8BDD\u91CC\u53EA\u80FD\u67E5\u5F85\u529E\u3001\u770B\u9879\u76EE\u5DE5\u4F5C\u9879\u3001\u6307\u6D3E\u4E0E\u63D0\u8BAE"
      });
    }
    return source.thread;
  }
  function memberIdentity(exec) {
    if (!exec?.sessionId || !exec.sessionId.trim()) {
      throw new HamsError("HOST_CAPABILITY_MISSING", "\u62FF\u4E0D\u5230\u670D\u52A1\u7AEF\u4F1A\u8BDD id\uFF0C\u65E0\u6CD5\u786E\u5B9A\u8C03\u7528\u8005\u8EAB\u4EFD");
    }
    const thread = resolve(db, exec.sessionId);
    if (thread) return { memberId: thread.memberId, thread };
    const owner = options.resolveSessionOwner?.(exec.sessionId);
    if (owner?.memberId) return { memberId: owner.memberId, thread: null };
    const chat = db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:session:${exec.sessionId}`);
    if (chat && chat.value) return { memberId: chat.value, thread: null };
    throw new HamsError("POLICY_DENIED", `\u4F1A\u8BDD\u672A\u7ED1\u5B9A\u4EFB\u4F55\u5DE5\u4F5C\u9879\uFF0C\u62D2\u7EDD\u6267\u884C\uFF1A${exec.sessionId}`);
  }
  function context(identityValue, exec, tool) {
    counter2 += 1;
    return {
      principalId: identityValue.memberId,
      channel: "tool",
      correlationId: exec.callId ?? `tool-${tool}-${counter2}`,
      idempotencyKey: options.idempotencyFor?.(exec, tool) ?? (exec.callId ? `${tool}:${exec.callId}` : void 0)
    };
  }
  function run(fn) {
    try {
      return { ok: true, data: fn() };
    } catch (error) {
      return fail(error);
    }
  }
  async function runAsync(fn) {
    try {
      return { ok: true, data: await fn() };
    } catch (error) {
      return fail(error);
    }
  }
  function groupPort() {
    if (!options.chat) {
      throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5B9E\u4F8B\u6CA1\u6709\u63A5\u5BBF\u4E3B\u4F1A\u8BDD\u670D\u52A1\uFF0C\u7FA4\u804A\u5DE5\u5177\u4E0D\u53EF\u7528", {
        nextStep: "\u91CD\u542F DSH \u8BA9\u63D2\u4EF6\u63A5\u4E0A agents \u670D\u52A1"
      });
    }
    return options.chat;
  }
  function ownedItemCheck(thread, workItemId) {
    if (thread.workItemId !== workItemId) {
      throw new HamsError("POLICY_DENIED", "\u672C\u4F1A\u8BDD\u53EA\u88AB\u7ED1\u5B9A\u5230\u4E00\u4E2A\u5DE5\u4F5C\u9879\uFF0C\u4E0D\u80FD\u64CD\u4F5C\u5176\u5B83\u5DE5\u4F5C\u9879");
    }
  }
  const tools = [
    {
      name: "hams_list_my_work",
      description: "\u5217\u51FA\u6307\u6D3E\u7ED9\u6211\u7684\u6216\u53EF\u8BA4\u9886\u7684\u5DE5\u4F5C\u9879\u3002\u53EA\u8BFB\u3002",
      parameters: {
        type: "object",
        properties: { status: { type: "string", description: "\u6309\u72B6\u6001\u8FC7\u6EE4" } },
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec);
          const args = rawArgs === void 0 ? {} : asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const status = optionalString(args.status, "status");
          const items = service.listWorkItems(context(member, exec, "list"), { limit: 50 });
          return items.filter((item) => {
            const mine = item.assignee_id === member.memberId;
            const claimable = item.status === "ready";
            if (!mine && !claimable) return false;
            return status ? item.status === status : true;
          });
        });
      }
    },
    {
      name: "hams_get_work_item",
      description: "\u8BFB\u53D6\u5DE5\u4F5C\u9879\u8BE6\u60C5\u4E0E\u5F53\u524D\u5141\u8BB8\u7684\u52A8\u4F5C\uFF08allowedActions\uFF09\u3002\u53EA\u8BFB\u3002",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const id = asString(args.id, "id");
          return service.getWorkItem(context(member, exec, "get"), id);
        });
      }
    },
    {
      name: "hams_claim",
      description: "\u8BA4\u9886\u4E00\u4E2A ready \u5DE5\u4F5C\u9879\uFF0C\u5EFA\u7ACB\u79DF\u7EA6\u4E0E\u8FD0\u884C\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          expectedEpoch: { type: "number", description: "\u8C03\u7528\u65B9\u770B\u5230\u7684\u6267\u884C\u4EE3\u6B21\uFF0C\u7528\u4E8E\u62D2\u7EDD\u8FC7\u671F\u64CD\u4F5C" }
        },
        required: ["id"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identityValue = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const id = asString(args.id, "id");
          const expectedEpoch = args.expectedEpoch === void 0 ? void 0 : asNumber(args.expectedEpoch, "expectedEpoch");
          if (expectedEpoch !== void 0) {
            const item = service.getWorkItem(context(identityValue, exec, "get"), id);
            if (item.execution_epoch !== expectedEpoch) {
              throw new HamsError("EPOCH_STALE", `\u6267\u884C\u4EE3\u6B21\u5DF2\u53D8\uFF1A\u671F\u671B ${expectedEpoch}\uFF0C\u5F53\u524D ${item.execution_epoch}`);
            }
          }
          return service.claim(context(identityValue, exec, "claim"), {
            workItemId: id,
            sessionId: exec.sessionId
          });
        });
      }
    },
    {
      name: "hams_assign_task",
      description: "\u628A\u4E00\u4E2A\u5F85\u5904\u7406\u7684\u5DE5\u4F5C\u9879\u6307\u6D3E\u7ED9\u53E6\u4E00\u4E2A\u5728\u5C97 bot\u3002\u53EA\u6709\u9879\u76EE\u7684\u63A8\u8FDB bot\uFF08coordinator\uFF09\u6216\u6709\u4EBA\u5DE5\u7BA1\u7406\u6743\u9650\u7684\u4EBA\u53EF\u4EE5\u6307\u6D3E\u3002\u6307\u6D3E\u540E\u5FC5\u987B\u5728\u7FA4\u804A\u91CC\u7528 hams_group_send \u5199\u51FA\u300C@\u8BE5 bot \u540D\u5B57\u300D\u8BF4\u660E\u4EFB\u52A1\uFF0C\u8BA9\u4EBA\u7C7B\u770B\u5F97\u89C1\u6D3E\u7ED9\u4E86\u8C01\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u5DE5\u4F5C\u9879 id" },
          assigneeId: { type: "string", description: "\u63A5\u4EFB\u52A1\u7684 bot \u6210\u5458 id" }
        },
        required: ["id", "assigneeId"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identity2 = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const workItemId = asString(args.id, "id");
          const assigneeId = asString(args.assigneeId, "assigneeId");
          const result = service.assignWorkItem(context(identity2, exec, "assign"), { workItemId, memberId: assigneeId });
          try {
            options.onAssigned?.(workItemId);
          } catch {
          }
          try {
            groupPort().noteAssignment?.(exec.sessionId, {
              memberId: assigneeId,
              text: `\u8BF7\u63A5\u624B\u5DE5\u4F5C\u9879 ${workItemId}\uFF0C\u5728\u7FA4\u91CC\u8BF4\u660E\u4E0B\u4E00\u6B65\u5E76\u63A5\u5355\u3002`
            });
          } catch {
          }
          return result;
        });
      }
    },
    {
      name: "hams_create_work_item",
      description: "\u5728\u9879\u76EE\u91CC\u767B\u8BB0\u4E00\u6761\u5DE5\u4F5C\u4EFB\u52A1\uFF08\u5DE5\u4F5C\u9879\uFF09\u3002\u9879\u76EE\u63A8\u8FDB bot \u53EF\u4EE5\u76F4\u63A5\u7ED9\u672C\u9879\u76EE\u5EFA\u5355\uFF1B\u5176\u4ED6 bot \u9700\u8981 work_item.create \u80FD\u529B\u3002\u540C\u4E00\u9879\u76EE + \u540C\u4E00\u6807\u9898\u4F1A\u81EA\u52A8\u53BB\u91CD\uFF0C\u91CD\u590D\u8C03\u7528\u8FD4\u56DE\u5DF2\u6709\u5DE5\u4F5C\u9879\u3002\u5EFA\u5355\u4E0D\u4F1A\u81EA\u52A8\u6D3E\u6D3B\uFF1A\u9700\u8981\u518D\u7528 hams_assign_task \u6307\u6D3E\uFF0C\u5E76\u5728\u7FA4\u804A\u91CC @ \u5BF9\u65B9\u3002\u5F53\u4EBA\u7C7B\u63D0\u51FA\u4E00\u4EF6\u65B0\u6D3B\u3001\u6216\u9879\u76EE\u76EE\u6807\u9700\u8981\u62C6\u6210\u53EF\u6267\u884C\u4EFB\u52A1\u65F6\u5148\u7528\u8FD9\u4E2A\u5DE5\u5177\u5EFA\u5355\uFF0C\u4E0D\u8981\u53EA\u5728\u7FA4\u91CC\u53E3\u5934\u7B54\u5E94\u3002",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "\u5DE5\u4F5C\u9879\u6240\u5C5E\u9879\u76EE id\uFF08\u5FC5\u586B\uFF09" },
          title: { type: "string", description: "\u4EFB\u52A1\u6807\u9898\uFF1A\u5199\u6E05\u8981\u4EA4\u4ED8\u4EC0\u4E48\u3001\u8303\u56F4\u4E0E\u9A8C\u6536\u53E3\u5F84" },
          domain: { type: "string", description: "\u4E1A\u52A1\u57DF\uFF1B\u7701\u7565\u4E3A\u300C\u901A\u7528\u300D" },
          category: { type: "string", description: "\u4EFB\u52A1\u7C7B\u522B\uFF1B\u7701\u7565\u4E3A\u300C\u6267\u884C\u300D" },
          ownerHumanId: { type: "string", description: "\u8D1F\u8D23\u4EBA\uFF08\u5FC5\u987B\u662F\u4EBA\u7684\u6210\u5458 id\uFF09\uFF1B\u7701\u7565\u4E3A\u9879\u76EE\u8D1F\u8D23\u4EBA" },
          templateVersionId: { type: "string", description: "\u5224\u636E\u6A21\u677F\u7248\u672C id\uFF1B\u7701\u7565\u5219\u5EFA\u5355\u540E\u518D\u8865" },
          dedupeKey: { type: "string", description: "\u5E42\u7B49\u952E\uFF1B\u7701\u7565\u65F6\u6309\u9879\u76EE + \u6807\u9898\u81EA\u52A8\u751F\u6210" },
          priority: { type: "number", description: "\u4F18\u5148\u7EA7\uFF0C\u6570\u5B57\u8D8A\u5C0F\u8D8A\u9760\u524D" },
          dueAt: { type: "number", description: "\u622A\u6B62\u65F6\u95F4\uFF08UTC \u6BEB\u79D2\uFF09" }
        },
        required: ["projectId", "title"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identity2 = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          return service.createWorkItem(context(identity2, exec, "create-work-item"), {
            projectId: asString(args.projectId, "projectId"),
            title: asString(args.title, "title"),
            domain: optionalString(args.domain, "domain") || "\u901A\u7528",
            category: optionalString(args.category, "category") || "\u6267\u884C",
            ownerHumanId: optionalString(args.ownerHumanId, "ownerHumanId"),
            templateVersionId: optionalString(args.templateVersionId, "templateVersionId"),
            dedupeKey: optionalString(args.dedupeKey, "dedupeKey"),
            priority: args.priority === void 0 ? void 0 : asNumber(args.priority, "priority"),
            dueAt: args.dueAt === void 0 ? void 0 : asNumber(args.dueAt, "dueAt")
          });
        });
      }
    },
    {
      name: "hams_list_project_work",
      description: "\u5217\u51FA\u4E00\u4E2A\u9879\u76EE\u4E0B\u7684\u5DE5\u4F5C\u9879\uFF08\u72B6\u6001\u3001\u8D1F\u8D23\u4EBA\u3001\u4E0B\u4E00\u6B65\u3001\u622A\u6B62\uFF09\uFF0C\u7528\u4E8E\u5728\u9879\u76EE\u7FA4\u804A\u91CC\u56DE\u7B54\u201C\u8FDB\u5C55\u5230\u54EA\u4E86\u201D\u3002",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          status: { type: "string", description: "\u53EF\u9009\uFF1A\u53EA\u770B\u67D0\u4E2A\u72B6\u6001" }
        },
        required: ["projectId"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identity2 = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          return service.listWorkItems(context(identity2, exec, "list-project"), {
            projectId: asString(args.projectId, "projectId"),
            status: optionalString(args.status, "status"),
            limit: 100
          }).map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            assigneeId: row.assignee_id,
            nextActionAt: row.next_action_at,
            dueAt: row.due_at,
            updatedAt: row.updated_at
          }));
        });
      }
    },
    {
      name: "hams_group_members",
      description: "\u5217\u51FA\u73B0\u5728\u8FD9\u4E2A\u9879\u76EE\u7FA4\u91CC\u7684\u6210\u5458\uFF08\u63A8\u8FDB bot\u3001\u624B\u52A8\u52A0\u5165\u7684 bot\u3001\u4E34\u65F6 bot\uFF09\u3002\u53EA\u8BFB\u3002",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec);
          assertNoIdentityArgs(rawArgs === void 0 ? {} : asObject(rawArgs, "args"));
          return groupPort().groupMembersBySession(exec.sessionId);
        });
      }
    },
    {
      name: "hams_group_send",
      description: "\u5728\u9879\u76EE\u7FA4\u91CC @ \u67D0\u4E2A\u6210\u5458\u8BF4\u4E00\u53E5\u8BDD\uFF1B\u6B63\u6587\u4F1A\u81EA\u52A8\u4EE5\u300C@\u6210\u5458\u540D\u300D\u5F00\u5934\uFF0C\u5BF9\u65B9\u7684\u56DE\u7B54\u4F1A\u5408\u5E76\u8FDB\u7FA4\u804A\u8BB0\u5F55\u3002\u6D3E\u6D3B\u5FC5\u987B\u7528\u5B83\uFF0C\u4E0D\u80FD\u53EA\u5728\u5FC3\u91CC\u6307\u6D3E\u3002",
      parameters: {
        type: "object",
        properties: {
          toMemberId: { type: "string", description: "\u8981 @ \u7684\u7FA4\u6210\u5458 id\uFF08\u5148\u7528 hams_group_members \u67E5\uFF09" },
          text: { type: "string" }
        },
        required: ["toMemberId", "text"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return runAsync(async () => {
          memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          return groupPort().groupSpeakBySession(exec.sessionId, {
            toMemberId: asString(args.toMemberId, "toMemberId"),
            text: asString(args.text, "text")
          });
        });
      }
    },
    {
      name: "hams_remember",
      description: "\u5728\u9879\u76EE\u7FA4\u91CC\uFF0C\u628A\u63A8\u8FDB\u8FC7\u7A0B\u4E2D\u503C\u5F97\u8BB0\u4F4F\u7684\u5185\u5BB9\u8BB0\u8FDB\u9879\u76EE\u8BB0\u5FC6\uFF08\u4E8B\u5B9E/\u51B3\u7B56/\u504F\u597D/\u6559\u8BAD/\u80FD\u529B\uFF09\u3002\u9047\u5230\u51B3\u5B9A\u3001\u53E3\u5F84\u3001\u6559\u8BAD\u3001\u4EBA\u7684\u504F\u597D\u6216 bot \u80FD\u529B\u7ECF\u9A8C\u65F6\u4F7F\u7528\uFF1Bkind=capability \u65F6\u4F1A\u540C\u6B65\u4E00\u4EFD\u7ED9\u5BF9\u5E94 bot \u7684\u8BB0\u5FC6\uFF0CbotId \u7701\u7565\u5219\u9ED8\u8BA4\u4E3A\u5F53\u524D bot\u3002",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "\u4E00\u53E5\u8BDD\u6807\u9898\uFF08\u6700\u591A 120 \u5B57\uFF09" },
          body: { type: "string", description: "\u8BB0\u5FC6\u6B63\u6587\uFF1A\u4FDD\u7559\u4E86\u54EA\u4E9B\u4E8B\u5B9E\u3001\u4E3A\u4EC0\u4E48\u3001\u4EE5\u540E\u600E\u4E48\u505A" },
          kind: {
            type: "string",
            enum: ["fact", "decision", "preference", "lesson", "capability"],
            description: "\u4E8B\u5B9E / \u51B3\u7B56 / \u504F\u597D / \u6559\u8BAD / \u80FD\u529B"
          },
          botId: { type: "string", description: "\u80FD\u529B\u7C7B\u5F52\u5C5E\u7684 bot \u6210\u5458 id\uFF1B\u7701\u7565 = \u5F53\u524D bot" }
        },
        required: ["title", "body", "kind"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const port = groupPort();
          if (!port.rememberBySession) throw new HamsError("HOST_CAPABILITY_MISSING", "\u5F53\u524D\u5BBF\u4E3B\u6CA1\u6709\u63A5\u9879\u76EE\u8BB0\u5FC6\u670D\u52A1");
          return port.rememberBySession(exec.sessionId, {
            title: asString(args.title, "title"),
            body: asString(args.body, "body"),
            kind: asString(args.kind, "kind"),
            botId: optionalString(args.botId, "botId")
          });
        });
      }
    },
    {
      name: "hams_group_spawn_bot",
      description: "\u5728\u9879\u76EE\u7FA4\u91CC\u521B\u5EFA\u4E00\u4E2A\u53EA\u5C5E\u4E8E\u8FD9\u4E2A\u9879\u76EE\u7684\u4E34\u65F6 bot\uFF08\u4E4B\u540E\u53EF\u7528 hams_group_send @ \u5B83\uFF0C\u6B63\u6587\u8981\u5199\u51FA @\u540D\u5B57\uFF09\u3002\u53EA\u6709\u63A8\u8FDB bot \u80FD\u5EFA\u3002",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u4E34\u65F6 bot \u7684\u540D\u5B57\uFF08\u6700\u591A 24 \u5B57\uFF09" },
          brief: { type: "string", description: "\u7ED9\u5B83\u7684\u4E00\u53E5\u8BDD\u804C\u8D23\u8BF4\u660E" }
        },
        required: ["name"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          return groupPort().groupSpawnBySession(exec.sessionId, {
            name: asString(args.name, "name"),
            brief: optionalString(args.brief, "brief")
          });
        });
      }
    },
    {
      name: "hams_append_evidence",
      description: "\u4E3A\u5DE5\u4F5C\u9879\u8FFD\u52A0\u8BC1\u636E\uFF1B\u8BC1\u636E\u53EA\u589E\u4E0D\u6539\uFF0C\u66F4\u6B63\u8BF7\u53E6\u8D77\u4E00\u6761\u5E76\u6307\u5411\u88AB\u66FF\u4EE3\u884C\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", description: "reading / photo / receipt / log / doc" },
          ref: { type: "string", description: "\u8BC1\u636E\u5F15\u7528\u8DEF\u5F84\u6216\u6807\u8BC6" },
          observedAt: { type: "number", description: "\u4E8B\u5B9E\u53D1\u751F\u65F6\u95F4\uFF08UTC \u6BEB\u79D2\uFF09" },
          source: { type: "string" }
        },
        required: ["id", "kind", "ref", "observedAt"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const workItemId = asString(args.id, "id");
          ownedItemCheck(thread, workItemId);
          const runRow = db.prepare(
            `SELECT id FROM task_run WHERE work_item_id = ? AND member_id = ?
                ORDER BY created_at DESC LIMIT 1`
          ).get(workItemId, thread.memberId);
          return service.appendEvidence(context(thread, exec, "append_evidence"), {
            workItemId,
            kind: asString(args.kind, "kind"),
            ref: asString(args.ref, "ref"),
            observedAt: asNumber(args.observedAt, "observedAt"),
            source: optionalString(args.source, "source"),
            runId: runRow?.id ?? null
          });
        });
      }
    },
    {
      name: "hams_submit_result",
      description: "\u7ED3\u675F\u672C\u8F6E\u8FD0\u884C\u5E76\u63D0\u4EA4\u7ED3\u679C\u6458\u8981\uFF1B\u5DE5\u4F5C\u9879\u4F1A\u8FDB\u5165\u590D\u67E5\u6216\u7B49\u5F85\u9A8C\u6536\u3002",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, summary: { type: "string" } },
        required: ["id", "summary"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const workItemId = asString(args.id, "id");
          ownedItemCheck(thread, workItemId);
          const current = db.prepare(
            `SELECT id FROM task_run WHERE work_item_id = ? AND member_id = ? AND status = 'running'
                ORDER BY created_at DESC LIMIT 1`
          ).get(workItemId, thread.memberId);
          if (!current) throw new HamsError("STATE_INVALID", "\u5F53\u524D\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF1B\u5148\u8BA4\u9886\u5E76\u5F00\u59CB\u8FD0\u884C");
          return service.submitResult(context(thread, exec, "submit_result"), {
            runId: current.id,
            summary: asString(args.summary, "summary")
          });
        });
      }
    },
    {
      name: "hams_evaluate_check",
      description: "\u5BF9\u5230\u671F\u590D\u67E5\u505A\u5224\u5B9A\uFF1B\u670D\u52A1\u7AEF\u4F1A\u6309\u8BC1\u636E\u6E05\u5355\u590D\u6838\uFF0C\u4E0D\u91C7\u4FE1\u6A21\u578B\u81EA\u8FF0\u3002",
      parameters: {
        type: "object",
        properties: { checkId: { type: "string" } },
        required: ["checkId"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const checkId = asString(args.checkId, "checkId");
          const row = db.prepare(
            `SELECT c.work_item_id AS work_item_id, w.assignee_id AS assignee_id
                 FROM work_item_check c JOIN work_item w ON w.id = c.work_item_id
                WHERE c.id = ?`
          ).get(checkId);
          if (!row) throw new HamsError("STATE_INVALID", `\u590D\u67E5\u4E0D\u5B58\u5728\uFF1A${checkId}`);
          if (row.assignee_id !== thread.memberId) {
            throw new HamsError("POLICY_DENIED", "\u53EA\u80FD\u5224\u5B9A\u81EA\u5DF1\u540D\u4E0B\u7684\u590D\u67E5");
          }
          return service.evaluateCheck(context(thread, exec, "evaluate_check"), { checkId });
        });
      }
    },
    {
      name: "hams_report_blocker",
      description: "\u4E0A\u62A5\u963B\u585E\uFF0C\u5E76\u7ED9\u51FA\u963B\u585E\u7C7B\u522B\u4E0E\u8BF4\u660E\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: {
            type: "string",
            enum: ["needs_evidence", "external", "dependency", "permission", "human_input", "data_source"]
          },
          note: { type: "string" }
        },
        required: ["id", "category", "note"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const workItemId = asString(args.id, "id");
          ownedItemCheck(thread, workItemId);
          return service.reportBlocker(context(thread, exec, "report_blocker"), {
            workItemId,
            category: asString(args.category, "category"),
            note: asString(args.note, "note", { allowEmpty: true })
          });
        });
      }
    },
    {
      name: "hams_request_closure",
      description: "\u8BF7\u793A\u5173\u5355\uFF1A\u670D\u52A1\u7AEF\u6838\u5BF9\u8BC1\u636E\u6E05\u5355\u4E0E\u9A8C\u8BC1\u5668\u540E\u751F\u6210\u4EBA\u5DE5\u5BA1\u6279\u3002not \u76F4\u63A5\u5173\u5355\u3002",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const workItemId = asString(args.id, "id");
          ownedItemCheck(thread, workItemId);
          return service.requestClosure(context(thread, exec, "request_closure"), {
            workItemId,
            reason: asString(args.reason, "reason")
          });
        });
      }
    },
    {
      name: "hams_propose",
      description: "\u63D0\u51FA\u60F3\u505A\u7684\u4E8B\uFF08\u5EFA\u5355 / \u5347\u7EA7 / \u6743\u9650 / \u8303\u56F4 / \u77E5\u8BC6\u53D8\u66F4\uFF09\uFF0C\u7531\u4EBA\u51B3\u5B9A\uFF1B\u63D0\u8BAE\u4E0D\u6539\u53D8\u5DE5\u4F5C\u9879\u3002",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["create_task", "upgrade_task", "permission_request", "scope_change", "knowledge_change"]
          },
          subjectKey: { type: "string", description: "project:<id> \u6216 work_item:<id> \u6216 global" },
          dedupeKey: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          rationale: {
            type: "object",
            description: "\u5FC5\u987B\u5305\u542B evidence \u6570\u7EC4\uFF08\u53EF\u4EE5\u662F\u5F15\u7528\uFF0C\u4F46\u4E0D\u80FD\u4E3A\u7A7A\uFF09",
            properties: { evidence: { type: "array" }, expectedEffect: { type: "string" }, cost: {} },
            required: ["evidence"]
          }
        },
        required: ["kind", "subjectKey", "dedupeKey", "title", "body", "rationale"],
        additionalProperties: false
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec);
          const args = asObject(rawArgs, "args");
          assertNoIdentityArgs(args);
          const subjectKey = asString(args.subjectKey, "subjectKey");
          const deciderId = resolveDecider(db, subjectKey);
          const rationale = asObject(args.rationale, "rationale");
          const evidence = rationale.evidence;
          if (!Array.isArray(evidence) || evidence.length === 0) {
            throw new HamsError("POLICY_DENIED", "\u63D0\u8BAE\u5FC5\u987B\u5E26\u8BC1\u636E\uFF1Arationale.evidence \u4E0D\u80FD\u4E3A\u7A7A");
          }
          return service.propose(context(member, exec, "propose"), {
            kind: asString(args.kind, "kind"),
            subjectKey,
            dedupeKey: asString(args.dedupeKey, "dedupeKey"),
            deciderId,
            title: asString(args.title, "title"),
            body: asString(args.body, "body"),
            rationale: {
              evidence,
              expectedEffect: optionalString(rationale.expectedEffect, "rationale.expectedEffect")
            }
          });
        });
      }
    }
  ];
  return tools;
}
function resolveDecider(db, subjectKey) {
  if (subjectKey.startsWith("project:")) {
    const projectId = subjectKey.slice("project:".length);
    const row = db.prepare("SELECT owner_human_id FROM project WHERE id = ?").get(projectId);
    if (row) return row.owner_human_id;
  }
  if (subjectKey.startsWith("work_item:")) {
    const workItemId = subjectKey.slice("work_item:".length);
    const row = db.prepare("SELECT owner_human_id FROM work_item WHERE id = ?").get(workItemId);
    if (row) return row.owner_human_id;
  }
  throw new HamsError("POLICY_DENIED", "\u63D0\u8BAE\u5FC5\u987B\u6302\u5728\u9879\u76EE\u6216\u5DE5\u4F5C\u9879\u4E0A\uFF0C\u7531\u5BF9\u5E94\u8D1F\u8D23\u4EBA\u51B3\u5B9A");
}
var TOOL_NAMES = [
  "hams_list_my_work",
  "hams_get_work_item",
  "hams_claim",
  "hams_assign_task",
  "hams_create_work_item",
  "hams_list_project_work",
  "hams_group_members",
  "hams_group_send",
  "hams_remember",
  "hams_group_spawn_bot",
  "hams_append_evidence",
  "hams_submit_result",
  "hams_evaluate_check",
  "hams_report_blocker",
  "hams_request_closure",
  "hams_propose"
];

// src/service/tick.ts
import { existsSync as existsSync5, unlinkSync as unlinkSync3 } from "node:fs";
import path6 from "node:path";
var DEFAULT_MAX_ITEMS = 50;
var DEFAULT_TZ2 = "Asia/Shanghai";
var DEFAULT_RETENTION_DAYS = 365;
var OPEN_DEDUPE_STATUSES = ["ready", "active", "waiting_check", "waiting_review", "blocked", "paused", "failed"];
function rollbackIfNeeded(db) {
  if (db.isTransaction) db.exec("ROLLBACK");
}
function runStep(db, bag, name2, fn) {
  rollbackIfNeeded(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackIfNeeded(db);
    bag.errors.push(`${name2}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
function attention(db, ids, input) {
  db.prepare(
    `INSERT INTO attention_item (id, work_item_id, project_id, reason, detail, to_member_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ids(),
    input.workItemId ?? null,
    input.projectId ?? null,
    input.reason,
    input.detail,
    input.toMemberId,
    input.at
  );
}
function humanOwnerOf(db, workItemId) {
  if (!workItemId) return null;
  const row = db.prepare(
    `SELECT w.owner_human_id AS owner, m.kind AS kind
         FROM work_item w JOIN member m ON m.id = w.owner_human_id
        WHERE w.id = ?`
  ).get(workItemId);
  return row && row.kind === "human" ? row.owner : null;
}
function hasTable(db, name2) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name2)
  );
}
function readRuntimeEpoch(db) {
  const row = db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get();
  return Number(row?.value ?? 0);
}
function parseInterval(spec) {
  const match = /^(\d+)\s*([smhd])$/.exec(spec.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5;
  return value * factor;
}
function recover(options) {
  const db = options.db;
  const now = options.now ?? (() => Date.now());
  const ids = options.ids ?? createIdFactory(now);
  const runtimeEpoch = options.runtimeEpoch;
  const startedAt = now();
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const bag = { errors: [] };
  const runs = runStep(db, bag, "recover-runs", () => {
    const stale = db.prepare(
      `SELECT id, work_item_id, status, member_id FROM task_run
          WHERE runtime_epoch < ? AND status IN ('queued','running')
          LIMIT ?`
    ).all(runtimeEpoch, max);
    let cancelled = 0;
    let orphaned = 0;
    for (const run of stale) {
      db.prepare("DELETE FROM lease WHERE run_id = ?").run(run.id);
      if (run.status === "queued") {
        db.prepare("UPDATE task_run SET status = 'cancelled', finished_at = ?, error_kind = 'host_restart_before_start' WHERE id = ?").run(startedAt, run.id);
        cancelled += 1;
      } else {
        db.prepare("UPDATE task_run SET status = 'orphaned', finished_at = ?, error_kind = 'host_restart_during_run' WHERE id = ?").run(startedAt, run.id);
        orphaned += 1;
        const owner = humanOwnerOf(db, run.work_item_id);
        if (owner) {
          attention(db, ids, {
            workItemId: run.work_item_id,
            reason: "orphaned_run",
            detail: `\u5BBF\u4E3B\u91CD\u542F\u65F6\u8FD0\u884C ${run.id} \u4ECD\u5728\u6267\u884C\uFF0C\u5DF2\u6807\u5B64\u513F\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u662F\u5426\u5DF2\u4EA7\u751F\u5916\u90E8\u526F\u4F5C\u7528`,
            toMemberId: owner,
            at: startedAt
          });
        }
      }
    }
    return { cancelled, orphaned };
  });
  const outbox = runStep(db, bag, "recover-outbox", () => {
    const sending = db.prepare("SELECT id, work_item_id, requested_by, action FROM outbox WHERE status = 'sending' LIMIT ?").all(max);
    let unknown = 0;
    for (const row of sending) {
      db.prepare("UPDATE outbox SET status = 'unknown', last_error = 'host_restart_during_send' WHERE id = ?").run(row.id);
      unknown += 1;
      const requesterIsHuman = db.prepare("SELECT kind FROM member WHERE id = ?").get(row.requested_by)?.kind === "human";
      const to = humanOwnerOf(db, row.work_item_id) ?? (requesterIsHuman ? row.requested_by : null);
      if (to) {
        attention(db, ids, {
          workItemId: row.work_item_id,
          reason: "outbox_unknown",
          detail: `\u51FA\u7AD9\u52A8\u4F5C ${row.action}\uFF08${row.id}\uFF09\u53D1\u9001\u7ED3\u679C\u672A\u77E5\uFF0C\u9700\u5BF9\u8D26\uFF0C\u4E0D\u8981\u76F4\u63A5\u91CD\u53D1`,
          toMemberId: to,
          at: startedAt
        });
      }
    }
    return unknown;
  });
  const approvals = runStep(db, bag, "recover-approvals", () => {
    const expired = db.prepare("UPDATE approval SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(startedAt);
    return Number(expired.changes);
  });
  const missed = runStep(db, bag, "recover-checks", () => {
    const row = db.prepare("SELECT COUNT(*) AS c FROM work_item_check WHERE status = 'scheduled' AND planned_due_at <= ?").get(startedAt);
    return Number(row.c);
  });
  const finishedAt = now();
  const report = {
    runtimeEpoch,
    startedAt,
    finishedAt,
    cancelledQueuedRuns: runs?.cancelled ?? 0,
    orphanedRunningRuns: runs?.orphaned ?? 0,
    outboxUnknown: outbox ?? 0,
    expiredApprovals: approvals ?? 0,
    missedChecks: missed ?? 0,
    tickSeq: 0
  };
  const logged = runStep(db, bag, "recover-log", () => {
    db.prepare(
      `INSERT INTO tick_log (runtime_epoch, started_at, finished_at, fired, recovered, error_text)
       VALUES (?, ?, ?, 0, 1, ?)`
    ).run(runtimeEpoch, startedAt, finishedAt, bag.errors.length ? bag.errors.join("; ") : null);
    return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  });
  report.tickSeq = logged ?? 0;
  return report;
}
function runTick(options) {
  const db = options.db;
  const now = options.now ?? (() => Date.now());
  const ids = options.ids ?? createIdFactory(now);
  const runtimeEpoch = options.runtimeEpoch ?? readRuntimeEpoch(db);
  const timeZone = options.timeZone ?? DEFAULT_TZ2;
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const startedAt = now();
  const bag = { errors: [] };
  const steps = {
    expiredApprovals: 0,
    reclaimedLeases: 0,
    queuedCheckRuns: 0,
    missedChecks: 0,
    cancelledChecks: 0,
    firedSchedules: 0,
    scheduledWorkItems: 0,
    outboxSent: 0,
    outboxFailed: 0,
    outboxUnknown: 0,
    outboxPending: 0,
    rollupRows: 0,
    purgedEvidence: 0
  };
  const expired = runStep(db, bag, "expire-approvals", () => {
    const result = db.prepare("UPDATE approval SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(startedAt);
    return Number(result.changes);
  });
  steps.expiredApprovals = expired ?? 0;
  const leases = runStep(db, bag, "reclaim-leases", () => {
    const rows = db.prepare("SELECT work_item_id, run_id FROM lease WHERE lease_until <= ? LIMIT ?").all(startedAt, max);
    for (const row of rows) {
      db.prepare("DELETE FROM lease WHERE work_item_id = ?").run(row.work_item_id);
      db.prepare("UPDATE task_run SET status = 'unknown', finished_at = ?, error_kind = 'lease_expired' WHERE id = ? AND status = 'running'").run(startedAt, row.run_id);
    }
    return rows.length;
  });
  steps.reclaimedLeases = leases ?? 0;
  const checks = runStep(db, bag, "due-checks", () => {
    const due = db.prepare(
      `SELECT c.*, v.misfire_policy AS misfire_policy
           FROM work_item_check c
           LEFT JOIN work_template_version v ON v.id = c.template_version_id
          WHERE c.status = 'scheduled' AND c.planned_due_at <= ?
          ORDER BY c.work_item_id, c.planned_due_at
          LIMIT ?`
    ).all(startedAt, max * 2);
    const latestByItem = /* @__PURE__ */ new Map();
    for (const check of due) {
      if ((check.misfire_policy ?? "each") !== "catch_up_latest") continue;
      const current = latestByItem.get(check.work_item_id);
      if (!current || db.prepare("SELECT planned_due_at FROM work_item_check WHERE id = ?").get(current).planned_due_at < check.planned_due_at) {
        latestByItem.set(check.work_item_id, check.id);
      }
    }
    let queuedRuns = 0;
    let missed = 0;
    let cancelled = 0;
    for (const check of due) {
      const policy = check.misfire_policy ?? "each";
      const item = db.prepare("SELECT * FROM work_item WHERE id = ?").get(check.work_item_id);
      if (!item || ["completed", "cancelled", "failed"].includes(item.status)) {
        db.prepare("UPDATE work_item_check SET status = 'cancelled' WHERE id = ?").run(check.id);
        cancelled += 1;
        continue;
      }
      if (policy === "catch_up_latest" && latestByItem.get(item.id) !== check.id) {
        db.prepare("UPDATE work_item_check SET status = 'cancelled' WHERE id = ?").run(check.id);
        cancelled += 1;
        continue;
      }
      if (policy === "skip") {
        db.prepare("UPDATE work_item_check SET status = 'unknown', evaluated_at = ? WHERE id = ?").run(startedAt, check.id);
        const owner = humanOwnerOf(db, item.id);
        if (owner) {
          attention(db, ids, {
            workItemId: item.id,
            reason: "missed_check",
            detail: `\u590D\u67E5 ${check.id} \u5230\u671F\u4F46\u6A21\u677F\u7B56\u7565\u4E3A skip\uFF0C\u672A\u6267\u884C`,
            toMemberId: owner,
            at: startedAt
          });
        }
        missed += 1;
        continue;
      }
      if (item.status === "waiting_review" || item.status === "paused") continue;
      const thread = db.prepare(
        `SELECT * FROM work_item_thread
            WHERE work_item_id = ? AND member_id = ? AND status = 'active'
            ORDER BY generation DESC LIMIT 1`
      ).get(item.id, item.assignee_id ?? "");
      const activeRun = db.prepare("SELECT 1 FROM task_run WHERE work_item_id = ? AND status IN ('queued','running')").get(item.id);
      if (!thread || !item.assignee_id || activeRun) {
        db.prepare("UPDATE work_item_check SET status = 'unknown', evaluated_at = ? WHERE id = ?").run(startedAt, check.id);
        const owner = humanOwnerOf(db, item.id);
        if (owner) {
          attention(db, ids, {
            workItemId: item.id,
            reason: "missed_check",
            detail: thread ? `\u590D\u67E5 ${check.id} \u5230\u671F\uFF0C\u4F46\u8BE5\u5DE5\u4F5C\u9879\u5DF2\u6709\u6D3B\u8DC3\u8FD0\u884C\uFF0C\u672A\u91CD\u590D\u8D77\u8DD1` : `\u590D\u67E5 ${check.id} \u5230\u671F\uFF0C\u4F46\u5DE5\u4F5C\u9879\u6CA1\u6709\u5728\u7528\u7684\u4F1A\u8BDD\u7EBF\u7A0B\uFF0C\u65E0\u6CD5\u8D77\u8FD0\u884C`,
            toMemberId: owner,
            at: startedAt
          });
        }
        missed += 1;
        continue;
      }
      const fenceRow = db.prepare("SELECT fence_seq FROM work_item WHERE id = ?").get(item.id);
      const fence = Number(fenceRow.fence_seq) + 1;
      const runId = ids();
      db.prepare(
        `UPDATE work_item SET fence_seq = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
      ).run(fence, startedAt, item.id);
      db.prepare(
        `INSERT INTO task_run
           (id, work_item_id, thread_id, check_id, member_id, member_version, skill_versions_json,
            execution_epoch, runtime_epoch, fence, trigger, attempt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'check', 1, 'queued', ?)`
      ).run(
        runId,
        item.id,
        thread.id,
        check.id,
        item.assignee_id,
        thread.member_version,
        item.execution_epoch,
        runtimeEpoch,
        fence,
        startedAt
      );
      db.prepare("UPDATE work_item_check SET status = 'running' WHERE id = ?").run(check.id);
      const after = db.prepare("SELECT revision FROM work_item WHERE id = ?").get(item.id);
      writeEvent(db, ids(), {
        workItemId: item.id,
        kind: "check_run_queued",
        actorId: "system",
        actorKind: "system",
        payload: { checkId: check.id, runId, fence },
        revision: after.revision,
        executionEpoch: item.execution_epoch,
        at: startedAt
      });
      writeChange(db, { objectKind: "task_run", objectId: runId, revision: 1, changeKind: "check_run_queued", at: startedAt });
      queuedRuns += 1;
    }
    return { queuedRuns, missed, cancelled };
  });
  steps.queuedCheckRuns = checks?.queuedRuns ?? 0;
  steps.missedChecks = checks?.missed ?? 0;
  steps.cancelledChecks = checks?.cancelled ?? 0;
  const schedules = runStep(db, bag, "due-schedules", () => {
    const due = db.prepare(
      `SELECT * FROM schedule
          WHERE enabled = 1 AND next_fire_at <= ?
          ORDER BY next_fire_at
          LIMIT ?`
    ).all(startedAt, max);
    let fired = 0;
    let created = 0;
    for (const schedule of due) {
      const plannedAt = schedule.next_fire_at;
      const existing = db.prepare("SELECT work_item_id FROM schedule_occurrence WHERE schedule_id = ? AND planned_at = ?").get(schedule.id, plannedAt);
      if (existing) {
        db.prepare("UPDATE schedule SET next_fire_at = ?, fired_count = fired_count + 1 WHERE id = ?").run(plannedAt + 1e3, schedule.id);
        continue;
      }
      let nextFire = null;
      if (schedule.kind === "every") {
        const interval = parseInterval(schedule.spec);
        if (!interval) {
          bag.errors.push(`schedule ${schedule.id}: \u4E0D\u652F\u6301\u7684\u5468\u671F\u5199\u6CD5 ${schedule.spec}`);
          db.prepare(
            `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, fired_at) VALUES (?, ?, 'skipped', ?)`
          ).run(schedule.id, plannedAt, startedAt);
          continue;
        }
        nextFire = plannedAt + interval;
        while (nextFire <= startedAt) nextFire += interval;
      } else if (schedule.kind === "at") {
        nextFire = null;
      } else {
        bag.errors.push(`schedule ${schedule.id}: tick \u6682\u4E0D\u652F\u6301 kind=${schedule.kind}`);
        db.prepare(
          `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, fired_at) VALUES (?, ?, 'skipped', ?)`
        ).run(schedule.id, plannedAt, startedAt);
        continue;
      }
      let workItemId = null;
      if (schedule.template_version_id) {
        const dedupeKey = `schedule:${schedule.id}:${plannedAt}`;
        const open = db.prepare(
          `SELECT id FROM work_item WHERE dedupe_key = ? AND status IN (${OPEN_DEDUPE_STATUSES.map(() => "?").join(",")}) LIMIT 1`
        ).get(dedupeKey, ...OPEN_DEDUPE_STATUSES);
        if (open) {
          workItemId = open.id;
        } else {
          const template = db.prepare(
            `SELECT v.id, t.name FROM work_template_version v JOIN work_template t ON t.id = v.template_id WHERE v.id = ?`
          ).get(schedule.template_version_id);
          if (template) {
            try {
              const item = insertWorkItem(
                { db, ids, now: () => startedAt, timeZone },
                {
                  domain: "\u8FD0\u8425",
                  category: "\u4F8B\u884C",
                  title: `${template.name}\uFF08${new Date(plannedAt).toISOString().slice(0, 10)}\uFF09`,
                  ownerHumanId: schedule.owner_human_id,
                  projectId: schedule.project_id,
                  templateVersionId: template.id,
                  dedupeKey,
                  createdBy: "system",
                  actorKind: "system"
                }
              );
              workItemId = item.id;
              created += 1;
            } catch (error) {
              bag.errors.push(`schedule ${schedule.id} \u751F\u5355\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
      const reachedMax = schedule.max_fires !== null && schedule.fired_count + 1 >= Number(schedule.max_fires);
      db.prepare(
        `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, work_item_id, fired_at)
         VALUES (?, ?, 'fired', ?, ?)`
      ).run(schedule.id, plannedAt, workItemId, startedAt);
      db.prepare("UPDATE schedule SET next_fire_at = ?, fired_count = fired_count + 1, enabled = ?, revision = revision + 1 WHERE id = ?").run(
        nextFire ?? plannedAt,
        reachedMax || nextFire === null ? 0 : 1,
        schedule.id
      );
      fired += 1;
    }
    return { fired, created };
  });
  steps.firedSchedules = schedules?.fired ?? 0;
  steps.scheduledWorkItems = schedules?.created ?? 0;
  const outbox = runStep(db, bag, "due-outbox", () => {
    const due = db.prepare(
      `SELECT * FROM outbox
          WHERE status = 'pending' AND available_at <= ?
            AND (not_after IS NULL OR not_after > ?)
          ORDER BY available_at LIMIT ?`
    ).all(startedAt, startedAt, max);
    if (!options.sendOutbox) return { sent: 0, failed: 0, unknown: 0, pending: due.length };
    let sent = 0;
    let failed = 0;
    let unknown = 0;
    for (const row of due) {
      db.prepare("UPDATE outbox SET status = 'sending', sending_at = ?, attempts = attempts + 1 WHERE id = ?").run(startedAt, row.id);
      const result = options.sendOutbox({
        id: row.id,
        action: row.action,
        payloadJson: row.payload_json,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts
      });
      if (result.status === "sent") {
        db.prepare("UPDATE outbox SET status = 'sent', external_ref = ?, finished_at = ? WHERE id = ?").run(result.externalRef ?? null, startedAt, row.id);
        sent += 1;
      } else if (result.status === "failed") {
        db.prepare("UPDATE outbox SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?").run(result.error ?? "send_failed", startedAt, row.id);
        failed += 1;
      } else {
        db.prepare("UPDATE outbox SET status = 'unknown', last_error = ?, finished_at = ? WHERE id = ?").run(result.error ?? "unknown_result", startedAt, row.id);
        unknown += 1;
      }
    }
    return { sent, failed, unknown, pending: 0 };
  });
  steps.outboxSent = outbox?.sent ?? 0;
  steps.outboxFailed = outbox?.failed ?? 0;
  steps.outboxUnknown = outbox?.unknown ?? 0;
  steps.outboxPending = outbox?.pending ?? 0;
  const rollup = hasTable(db, "activity_daily") ? runStep(db, bag, "rollup-activity", () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(startedAt));
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? "0");
    const today = new Date(Date.UTC(pick("year"), pick("month") - 1, pick("day")));
    const yesterday = new Date(today.getTime() - 864e5);
    const date = yesterday.toISOString().slice(0, 10);
    const start = wallToUtc(timeZone, yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate(), 0, 0);
    const end = start + 864e5;
    const rows = db.prepare(
      `SELECT member_id,
                COUNT(*) AS runs,
                SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status IN ('failed','unknown','orphaned') THEN 1 ELSE 0 END) AS failed
           FROM task_run
          WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at < ?
          GROUP BY member_id`
    ).all(start, end);
    const upsert = db.prepare(
      `INSERT INTO activity_daily (member_id, date, runs, succeeded, failed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member_id, date) DO UPDATE SET
           runs = excluded.runs, succeeded = excluded.succeeded, failed = excluded.failed`
    );
    for (const row of rows) upsert.run(row.member_id, date, Number(row.runs), Number(row.succeeded), Number(row.failed));
    return rows.length;
  }) : 0;
  steps.rollupRows = rollup ?? 0;
  const purged = runStep(db, bag, "purge-evidence", () => {
    const retentionDays = options.evidenceRetentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = startedAt - retentionDays * 864e5;
    const rows = db.prepare(
      `SELECT id, work_item_id, ref FROM evidence
          WHERE purged_at IS NULL AND captured_at <= ? LIMIT ?`
    ).all(cutoff, max);
    let removed = 0;
    for (const row of rows) {
      if (options.dataDir) {
        const base = path6.resolve(options.dataDir, "evidence");
        const target = path6.resolve(options.dataDir, row.ref);
        const inside = target === base || target.startsWith(`${base}${path6.sep}`);
        if (!inside) {
          bag.errors.push(`evidence ${row.id}: ref \u8D8A\u51FA\u8BC1\u636E\u76EE\u5F55\uFF0C\u62D2\u7EDD\u5220\u9664\u6587\u4EF6`);
          continue;
        }
        if (existsSync5(target)) {
          unlinkSync3(target);
        }
      }
      db.prepare("UPDATE evidence SET purged_at = ? WHERE id = ?").run(startedAt, row.id);
      removed += 1;
    }
    return removed;
  });
  steps.purgedEvidence = purged ?? 0;
  const finishedAt = now();
  const firedTotal = steps.expiredApprovals + steps.reclaimedLeases + steps.queuedCheckRuns + steps.firedSchedules + steps.scheduledWorkItems + steps.outboxSent;
  const tickSeq = runStep(db, bag, "tick-log", () => {
    db.prepare(
      `INSERT INTO tick_log (runtime_epoch, started_at, finished_at, fired, recovered, error_text)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(runtimeEpoch, startedAt, finishedAt, firedTotal, bag.errors.length ? bag.errors.join("; ") : null);
    return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  });
  return {
    tickSeq: tickSeq ?? 0,
    runtimeEpoch,
    startedAt,
    finishedAt,
    fired: firedTotal,
    steps,
    errors: bag.errors
  };
}
function createTicker(options) {
  const intervalMs = options.intervalMs ?? 5e3;
  let timer = null;
  let busy = false;
  return {
    runOnce() {
      return runTick(options);
    },
    running() {
      return busy;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        try {
          runTick(options);
        } finally {
          busy = false;
        }
      }, intervalMs);
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }
  };
}

// src/service/chat.ts
import { createHash as createHash10 } from "node:crypto";
var DEFAULT_BOT_PRESET = "hams-bot";
function promptContextBlock(prompt, preset) {
  const text4 = String(prompt || "").trim();
  if (!text4 || !preset || preset === DEFAULT_BOT_PRESET) return "";
  return `
\u3010\u4F60\u7684\u8BBE\u5B9A\uFF08\u6210\u5458\u914D\u7F6E\u53D1\u5E03\uFF1B\u4E0E\u901A\u7528\u8BF4\u660E\u51B2\u7A81\u65F6\u4EE5\u8FD9\u91CC\u4E3A\u51C6\uFF09\u3011
${text4}`;
}
function subagentTaskPrompt(events, createdAt) {
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw;
    if (event.type !== "user/message") continue;
    if (event.data?.source?.kind !== "user") continue;
    if (Number(event.time || 0) < Number(createdAt || 0)) continue;
    const content = Array.isArray(event.data.content) ? event.data.content : [];
    const text4 = content.filter((block2) => block2 && typeof block2 === "object" && block2.type === "text").map((block2) => String(block2.text ?? "")).join("\n").trim();
    if (text4) return text4.slice(0, 8192);
  }
  return "";
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var ChatService = class {
  db;
  runtime;
  now;
  id;
  intake;
  constructor(options) {
    this.db = options.db;
    this.runtime = options.runtime;
    this.now = options.now ?? (() => Date.now());
    this.id = options.idFactory ?? createIdFactory(this.now);
    this.intake = options.intake;
  }
  get available() {
    return this.runtime.available;
  }
  get reason() {
    return this.runtime.unavailableReason;
  }
  human(ctx) {
    const row = this.db.prepare("SELECT kind FROM member WHERE id = ?").get(ctx.principalId);
    if (!row || row.kind !== "human") {
      throw new HamsError("POLICY_DENIED", "\u53EA\u6709\u4EBA\u80FD\u53D1\u8D77\u5BF9\u8BDD\uFF1Bbot \u4E4B\u95F4\u4E0D\u79C1\u4E0B\u4F20\u8BDD", {
        nextStep: "bot \u7684\u534F\u4F5C\u901A\u8FC7\u5DE5\u4F5C\u9879\u4E0E\u63D0\u8BAE\uFF0C\u4E0D\u901A\u8FC7\u5BF9\u8BDD"
      });
    }
  }
  /** 解析对话对象：单聊落到 bot 本人，群聊落到项目推进 bot。 */
  peer(ctx, kind, targetId) {
    this.human(ctx);
    if (kind === "project") {
      const project = this.db.prepare("SELECT id, name, coordinator_id, deleted_at FROM project WHERE id = ?").get(targetId);
      if (!project || project.deleted_at) throw new HamsError("STATE_INVALID", `\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${targetId}`, { nextStep: "\u5237\u65B0\u9879\u76EE\u5217\u8868\u540E\u91CD\u8BD5" });
      if (!project.coordinator_id) {
        throw new HamsError("STATE_INVALID", "\u8FD9\u4E2A\u9879\u76EE\u8FD8\u6CA1\u6709\u63A8\u8FDB bot\uFF0C\u7FA4\u804A\u6CA1\u6709\u56DE\u7B54\u7684\u4EBA", {
          nextStep: "\u5728\u9879\u76EE\u8BE6\u60C5\u91CC\u6307\u5B9A\u300C\u63A8\u8FDB bot\u300D\uFF08\u65B0\u5EFA\u6216\u7F16\u8F91\u9879\u76EE\u65F6\u53EF\u4EE5\u9009\uFF09\uFF0C\u518D\u8FDB\u7FA4\u804A"
        });
      }
      return { ...this.bot(project.coordinator_id), kind, targetId, title: project.name };
    }
    const bot = this.bot(targetId);
    return { ...bot, kind: "member", targetId, title: bot.memberName };
  }
  bot(memberId) {
    const member = this.db.prepare("SELECT id, name, status, kind, current_version FROM member WHERE id = ?").get(memberId);
    if (!member || member.kind !== "bot") throw new HamsError("STATE_INVALID", `\u4E0D\u662F bot \u6210\u5458\uFF1A${memberId}`);
    if (member.status !== "active") {
      throw new HamsError("STATE_INVALID", `bot \u5F53\u524D\u4E0D\u5728\u5C97\uFF08${member.status}\uFF09\uFF0C\u5148\u6062\u590D\u5728\u5C97\u518D\u5BF9\u8BDD`, {
        nextStep: "\u5728\u667A\u80FD\u4F53\u8BE6\u60C5\u91CC\u70B9\u300C\u6062\u590D\u5728\u5C97\u300D"
      });
    }
    const version = Number(member.current_version || 0);
    const config = version ? this.db.prepare("SELECT agent_preset, model, prompt FROM member_version WHERE member_id = ? AND version = ?").get(memberId, version) : void 0;
    return {
      memberId,
      memberName: member.name,
      memberVersion: version,
      agentPreset: (config?.agent_preset || "").trim() || DEFAULT_BOT_PRESET,
      model: config?.model ?? null,
      prompt: config?.prompt || ""
    };
  }
  pointer(kind, targetId) {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:${kind}:${targetId}`);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed.sessionId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  savePointer(kind, targetId, pointer) {
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(`chat:${kind}:${targetId}`, JSON.stringify(pointer));
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(`chat:session:${pointer.sessionId}`, pointer.memberId);
  }
  requireRuntime() {
    if (!this.runtime.available) {
      throw new HamsError("HOST_CAPABILITY_MISSING", this.runtime.unavailableReason || "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B agent \u4F1A\u8BDD\u670D\u52A1", {
        nextStep: "\u786E\u8BA4 DSH \u8FD0\u884C\u65F6\u5E26 agents / sessionQuery \u670D\u52A1\u540E\u91CD\u542F\u63D2\u4EF6\uFF1B\u53EA\u8BFB\u5B9E\u4F8B\u4E0D\u80FD\u5F00\u5BF9\u8BDD"
      });
    }
  }
  /**
   * 打开（必要时创建）对话。配置版本、preset 或模型变了就换一个新会话，
   * 旧会话留在宿主里可查，但当前对话只跟最新配置走。
   */
  async open(ctx, input) {
    const peer = this.peer(ctx, input.kind, input.targetId);
    this.requireRuntime();
    const existing = this.pointer(input.kind, input.targetId);
    let model = peer.model;
    if (!model) {
      const fallback = this.runtime.defaultModel ? await this.runtime.defaultModel() : null;
      model = fallback ? `${fallback.provider}/${fallback.model}` : null;
    }
    if (!model) {
      throw new HamsError("HOST_CAPABILITY_MISSING", `${peer.memberName} \u6CA1\u6709\u914D\u7F6E\u6A21\u578B\uFF0C\u5BBF\u4E3B\u4E5F\u6CA1\u6709\u9ED8\u8BA4\u6A21\u578B`, {
        nextStep: "\u5728\u667A\u80FD\u4F53\u300C\u914D\u7F6E\u300D\u91CC\u9009\u4E00\u4E2A\u6A21\u578B\u5E76\u4FDD\u5B58\uFF1B\u6216\u5728\u5BBF\u4E3B\u8BBE\u7F6E\u91CC\u6307\u5B9A\u9ED8\u8BA4\u6A21\u578B"
      });
    }
    const sameConfig = existing && existing.memberId === peer.memberId && existing.memberVersion === peer.memberVersion && existing.agentPreset === peer.agentPreset && (existing.model || null) === model;
    const context = (input.kind === "project" ? `\u4F60\u5728 HAMS \u9879\u76EE\u300A${peer.title}\u300B\uFF08projectId=${input.targetId}\uFF09\u7684\u7FA4\u804A\u91CC\uFF0C\u662F\u8FD9\u4E2A\u9879\u76EE\u7684\u63A8\u8FDB bot\u3002\u4F60\u53EF\u4EE5\u7528 hams_list_project_work \u67E5\u8FD9\u4E2A\u9879\u76EE\u7684\u5DE5\u4F5C\u9879\u8FDB\u5C55\uFF0C\u7528 hams_assign_task \u628A ready \u5DE5\u4F5C\u9879\u6307\u6D3E\u7ED9\u5176\u4ED6 bot\uFF1B\u5173\u5355\u4E0E\u5BA1\u6279\u53EA\u80FD\u7531\u4EBA\u505A\u3002\u7528\u4E2D\u6587\u7B80\u77ED\u56DE\u7B54\u3002` + (projectMemoryBlock(this.db, input.targetId) ? `
${projectMemoryBlock(this.db, input.targetId)}` : "") : `\u4F60\u5728 HAMS \u91CC\u4F5C\u4E3A\u300A${peer.memberName}\u300B\u4E0E\u4EBA\u7C7B\u5355\u804A\uFF0C\u8EAB\u4EFD\u662F\u6210\u5458 ${peer.memberId}\u3002\u6D89\u53CA\u5DE5\u4F5C\u9879\u65F6\u7528 HAMS \u5DE5\u5177\u8BFB\u5199\u4E8B\u5B9E\uFF0C\u4E0D\u8981\u7F16\u9020\u72B6\u6001\uFF1B\u5173\u5355\u4E0E\u5BA1\u6279\u53EA\u80FD\u7531\u4EBA\u505A\u3002\u7528\u4E2D\u6587\u7B80\u77ED\u56DE\u7B54\u3002` + (memberMemoryBlock(this.db, peer.memberId) ? `
${memberMemoryBlock(this.db, peer.memberId)}` : "")) + promptContextBlock(peer.prompt, peer.agentPreset);
    const { sessionId } = await this.runtime.ensure({
      sessionId: sameConfig ? existing.sessionId : void 0,
      key: `chat:${input.kind}:${input.targetId}`,
      memberId: peer.memberId,
      memberName: peer.memberName,
      memberVersion: peer.memberVersion,
      agentPreset: peer.agentPreset,
      prompt: peer.prompt,
      model,
      title: input.kind === "project" ? `\u9879\u76EE\u7FA4\u804A \xB7 ${peer.title}` : `\u5355\u804A \xB7 ${peer.memberName}`,
      context
    });
    const at = Date.now();
    const pointer = {
      sessionId,
      memberId: peer.memberId,
      memberVersion: peer.memberVersion,
      agentPreset: peer.agentPreset,
      model,
      prompt: peer.prompt,
      at
    };
    if (!sameConfig || !existing) this.savePointer(input.kind, input.targetId, pointer);
    return { ...peer, model, sessionId, createdAt: existing?.at ?? at, updatedAt: at };
  }
  /** 单聊时反查这个 bot 唯一能代表的项目：优先它推进的项目，其次唯一参与的项目。 */
  projectForBot(memberId) {
    const coordinated = this.db.prepare("SELECT id FROM project WHERE coordinator_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY updated_at DESC").all(memberId);
    if (coordinated.length === 1) return coordinated[0].id;
    if (coordinated.length > 1) return null;
    const joined = this.db.prepare(
      `SELECT p.id FROM project_participant pp JOIN project p ON p.id = pp.project_id
          WHERE pp.member_id = ? AND pp.removed_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
          ORDER BY pp.added_at DESC`
    ).all(memberId);
    return joined.length === 1 ? joined[0].id : null;
  }
  intakeSystemText(outcome) {
    if (outcome.kind === "create") return `\u5DF2\u628A\u8FD9\u6761\u6D88\u606F\u767B\u8BB0\u4E3A\u5DE5\u4F5C\u9879\u300A${outcome.title}\u300B\uFF08${outcome.workItemId}\uFF09`;
    const label = { paused: "\u6682\u505C", active: "\u7EE7\u7EED", cancelled: "\u53D6\u6D88" }[outcome.status] || outcome.status;
    return `\u5DF2\u628A\u5DE5\u4F5C\u9879\u300A${outcome.title}\u300B\u72B6\u6001\u6539\u4E3A\u300C${label}\u300D`;
  }
  intakeNote(outcome) {
    if (!outcome) return "";
    if (outcome.kind === "create") {
      return `\u3010\u7CFB\u7EDF\u3011\u4EBA\u7C7B\u8FD9\u53E5\u8BDD\u5DF2\u7ECF\u767B\u8BB0\u4E3A\u5DE5\u4F5C\u9879 ${outcome.workItemId}\u300A${outcome.title}\u300B${outcome.created ? "" : "\uFF08\u6B64\u524D\u5DF2\u5B58\u5728\uFF0C\u76F4\u63A5\u590D\u7528\uFF09"}\uFF1B\u76F4\u63A5\u7528\u5B83\u63A8\u8FDB\u6216\u6D3E\u6D3B\uFF0C\u4E0D\u8981\u91CD\u590D\u5EFA\u5355\u3002

`;
    }
    return `\u3010\u7CFB\u7EDF\u3011\u4EBA\u7C7B\u8FD9\u53E5\u8BDD\u5DF2\u7ECF\u66F4\u65B0\u5DE5\u4F5C\u9879 ${outcome.workItemId}\u300A${outcome.title}\u300B\u7684\u72B6\u6001${outcome.changed ? "" : "\uFF08\u6B64\u524D\u5DF2\u662F\u8BE5\u72B6\u6001\uFF09"}\uFF1B\u4E0D\u8981\u518D\u91CD\u590D\u5904\u7406\u3002

`;
  }
  /** 人发出的一条消息是否要建单/改状态；返回要附加给 bot 的提示。 */
  async intakeNoteFor(ctx, thread, text4) {
    if (!this.intake) return "";
    const projectId = thread.kind === "project" ? thread.targetId : this.projectForBot(thread.memberId);
    if (!projectId) return "";
    let recent = "";
    try {
      const view = await this.runtime.read(thread.sessionId);
      recent = view.messages.slice(-4).map((message) => `${message.role}: ${message.text.slice(0, 200)}`).join("\n");
    } catch {
      recent = "";
    }
    const result = await this.intake.registerFromMessage({
      projectId,
      senderId: ctx.principalId,
      text: text4,
      messageId: `msg-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mentionedMemberId: null,
      recent
    });
    return this.intakeNote(result);
  }
  async send(ctx, input) {
    const text4 = String(input.text || "").trim();
    if (!text4) throw new HamsError("STATE_INVALID", "\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A");
    if (text4.length > 8e3) throw new HamsError("STATE_INVALID", "\u5355\u6761\u6D88\u606F\u4E0D\u80FD\u8D85\u8FC7 8000 \u5B57");
    const thread = await this.open(ctx, { kind: input.kind, targetId: input.targetId });
    const memory = thread.kind === "member" ? memberMemoryBlock(this.db, thread.memberId) : "";
    let intakeNote = "";
    try {
      intakeNote = await this.intakeNoteFor(ctx, thread, text4);
    } catch {
      intakeNote = "";
    }
    const body = memory ? `${memory}

${text4}` : text4;
    await this.runtime.send(thread.sessionId, intakeNote ? `${intakeNote}${body}` : body);
    return { sessionId: thread.sessionId, accepted: true };
  }
  async read(ctx, input) {
    this.human(ctx);
    if (!this.runtime.available) {
      return { thread: null, messages: [], running: false, available: false, reason: this.runtime.unavailableReason || "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B agent \u4F1A\u8BDD\u670D\u52A1" };
    }
    const pointer = this.pointer(input.kind, input.targetId);
    if (!pointer) return { thread: null, messages: [], running: false, available: true };
    let peer;
    try {
      peer = this.peer(ctx, input.kind, input.targetId);
    } catch (error2) {
      peer = {
        kind: input.kind,
        targetId: input.targetId,
        title: input.kind === "project" ? "\u9879\u76EE" : "\u667A\u80FD\u4F53",
        memberId: pointer.memberId,
        memberName: "",
        memberVersion: pointer.memberVersion,
        agentPreset: pointer.agentPreset,
        model: pointer.model,
        prompt: pointer.prompt || ""
      };
    }
    const { messages, running, error } = await this.runtime.read(pointer.sessionId);
    return {
      thread: { ...peer, sessionId: pointer.sessionId, createdAt: pointer.at, updatedAt: pointer.at },
      messages,
      running,
      available: true,
      ...error ? { error } : {}
    };
  }
  async stop(ctx, input) {
    this.human(ctx);
    this.requireRuntime();
    const pointer = this.pointer(input.kind, input.targetId);
    if (!pointer) throw new HamsError("STATE_INVALID", "\u8FD8\u6CA1\u6709\u5BF9\u8BDD\u53EF\u4EE5\u505C\u6B62");
    await this.runtime.stop(pointer.sessionId);
    return { stopped: true };
  }
  async presets() {
    if (!this.runtime.available) return [];
    return this.runtime.presets();
  }
  async models() {
    if (!this.runtime.available) return [];
    return this.runtime.models();
  }
  // ───────────────────────── 项目群：团队与多 bot 群聊 ─────────────────────────
  projectRow(projectId) {
    const row = this.db.prepare("SELECT id, name, coordinator_id, owner_human_id, status, deleted_at FROM project WHERE id = ?").get(projectId);
    if (!row || row.deleted_at) throw new HamsError("STATE_INVALID", `\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${projectId}`, { nextStep: "\u5237\u65B0\u9879\u76EE\u5217\u8868\u540E\u91CD\u8BD5" });
    return row;
  }
  memberRow(memberId) {
    return this.db.prepare("SELECT id, name, kind, status FROM member WHERE id = ?").get(memberId);
  }
  participantRow(projectId, memberId) {
    return this.db.prepare("SELECT kind, brief, removed_at FROM project_participant WHERE project_id = ? AND member_id = ?").get(projectId, memberId);
  }
  requireProjectAdmin(ctx) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    if (principal.kind !== "human") {
      throw new HamsError("POLICY_DENIED", "\u53EA\u6709\u9879\u76EE\u7BA1\u7406\u5458\u80FD\u624B\u52A8\u8C03\u6574\u56E2\u961F\u6210\u5458\uFF1B\u63A8\u8FDB bot \u8BF7\u7528 hams_group_spawn_bot", {
        nextStep: "\u8BA9\u7BA1\u7406\u5458\u5728\u9879\u76EE\u300C\u56E2\u961F\u300D\u91CC\u52A0\u4EBA"
      });
    }
    requireCapability(principal, CAPABILITY.projectManage);
    return principal;
  }
  pointerAt(key) {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(key);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed.sessionId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  savePointerAt(key, pointer) {
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(pointer));
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(`chat:session:${pointer.sessionId}`, pointer.memberId);
  }
  /** 群聊里某个成员自己的会话 key；推进 bot 沿用 chat:project:<id>，旧消息不断。 */
  groupKey(projectId, memberId, isCoordinator) {
    return isCoordinator ? `chat:project:${projectId}` : `chat:group:${projectId}:${memberId}`;
  }
  async ensureGroupSession(project, member, isCoordinator, context) {
    this.requireRuntime();
    const key = this.groupKey(project.id, member.memberId, isCoordinator);
    const existing = this.pointerAt(key);
    let model = member.model;
    if (!model) {
      const fallback = this.runtime.defaultModel ? await this.runtime.defaultModel() : null;
      model = fallback ? `${fallback.provider}/${fallback.model}` : null;
    }
    if (!model) {
      throw new HamsError("HOST_CAPABILITY_MISSING", `${member.memberName} \u6CA1\u6709\u914D\u7F6E\u6A21\u578B\uFF0C\u5BBF\u4E3B\u4E5F\u6CA1\u6709\u9ED8\u8BA4\u6A21\u578B`, {
        nextStep: "\u5728\u667A\u80FD\u4F53\u300C\u914D\u7F6E\u300D\u91CC\u9009\u4E00\u4E2A\u6A21\u578B\u5E76\u4FDD\u5B58\uFF1B\u6216\u5728\u5BBF\u4E3B\u8BBE\u7F6E\u91CC\u6307\u5B9A\u9ED8\u8BA4\u6A21\u578B"
      });
    }
    const same = Boolean(
      existing && existing.memberVersion === member.memberVersion && existing.agentPreset === member.agentPreset && (existing.model || null) === model
    );
    const { sessionId } = await this.runtime.ensure({
      sessionId: same ? existing.sessionId : void 0,
      key,
      memberId: member.memberId,
      memberName: member.memberName,
      memberVersion: member.memberVersion,
      agentPreset: member.agentPreset,
      prompt: member.prompt,
      model,
      title: `\u9879\u76EE\u7FA4 \xB7 ${project.name} \xB7 ${member.memberName}`,
      context: context + promptContextBlock(member.prompt, member.agentPreset)
    });
    const at = this.now();
    const pointer = {
      sessionId,
      memberId: member.memberId,
      memberVersion: member.memberVersion,
      agentPreset: member.agentPreset,
      model,
      prompt: member.prompt,
      at
    };
    this.savePointerAt(key, pointer);
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(`chat:group:session:${sessionId}`, project.id);
    return { sessionId, running: false };
  }
  /** 群里现在有谁：推进 bot + 参与者（手动加入的常驻 bot 与临时 bot）。 */
  teamRows(projectId) {
    const project = this.projectRow(projectId);
    const rows = [];
    if (project.coordinator_id) {
      const coordinator = this.memberRow(project.coordinator_id);
      if (coordinator) rows.push({ memberId: coordinator.id, name: coordinator.name, kind: "coordinator", status: coordinator.status, brief: "\u9879\u76EE\u63A8\u8FDB bot\uFF1A\u62C6\u4EFB\u52A1\u3001\u5206\u914D\u3001\u6C47\u603B" });
    }
    const members = this.db.prepare(
      `SELECT pp.member_id, pp.kind, pp.brief, pp.added_at, m.name, m.status
           FROM project_participant pp JOIN member m ON m.id = pp.member_id
          WHERE pp.project_id = ? AND pp.removed_at IS NULL
          ORDER BY pp.added_at`
    ).all(projectId);
    for (const row of members) {
      const kind = row.kind === "temp" && row.brief.startsWith("\u5B50\u4EE3\u7406") ? "subagent" : row.kind;
      rows.push({ memberId: row.member_id, name: row.name, kind, status: row.status, brief: row.brief, addedAt: row.added_at });
    }
    return rows;
  }
  rosterText(projectId) {
    const project = this.projectRow(projectId);
    const rows = this.teamRows(projectId);
    const kindLabel = (kind) => kind === "coordinator" ? "\u63A8\u8FDB bot" : kind === "subagent" ? "\u5B50\u4EE3\u7406" : kind === "temp" ? "\u4E34\u65F6 bot" : "\u6210\u5458";
    const lines = rows.map((row) => `- ${row.name}\uFF08${kindLabel(row.kind)}\uFF0Cid=${row.memberId}\uFF09`);
    return `\u3010\u9879\u76EE\u7FA4 ${project.name}\u3011\u56E2\u961F\u6210\u5458\uFF1A
${lines.join("\n")}`;
  }
  recentTranscript(projectId, limit = 12) {
    const rows = this.db.prepare("SELECT author_name, text, kind, to_member_id FROM project_message WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(projectId, limit);
    return rows.reverse().map((row) => `${row.author_name}${row.kind === "mention" ? " @\u67D0\u4EBA" : ""}\uFF1A${row.text}`).join("\n");
  }
  appendGroupMessage(input) {
    const id = this.id();
    this.db.prepare(
      `INSERT INTO project_message (id, project_id, author_kind, author_id, author_name, text, at, kind, to_member_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.authorKind,
      input.authorId,
      input.authorName,
      input.text,
      this.now(),
      input.kind || "chat",
      input.toMemberId ?? null,
      input.sessionId ?? null
    );
    return id;
  }
  /** 把每个成员会话里新产生的助手回复合并进群聊记录（按 seq 游标，幂等）。 */
  async syncGroup(projectId) {
    const project = this.projectRow(projectId);
    const members = this.teamRows(projectId);
    for (const member of members) {
      const isCoordinator = member.kind === "coordinator";
      const pointer = this.pointerAt(this.groupKey(projectId, member.memberId, isCoordinator));
      if (!pointer) continue;
      const cursor = this.db.prepare("SELECT last_seq FROM chat_cursor WHERE session_id = ?").get(pointer.sessionId);
      let lastSeq = cursor?.last_seq ?? 0;
      const { messages } = await this.runtime.read(pointer.sessionId);
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const seq = Number(message.seq ?? 0);
        if (seq <= lastSeq) continue;
        const messageId = this.appendGroupMessage({
          projectId,
          authorKind: "bot",
          authorId: member.memberId,
          authorName: member.name,
          text: message.text,
          kind: "chat",
          sessionId: pointer.sessionId
        });
        this.collectMemories(projectId, {
          id: messageId,
          authorKind: "bot",
          authorId: member.memberId,
          authorName: member.name,
          text: message.text
        });
        lastSeq = seq;
      }
      this.db.prepare("INSERT OR REPLACE INTO chat_cursor (session_id, project_id, last_seq) VALUES (?, ?, ?)").run(pointer.sessionId, project.id, lastSeq);
    }
  }
  /** 最近一次扫描子代理的时间；团队页轮询时别每次都翻全部会话。 */
  lastSubagentScan = 0;
  /**
   * DSH 的 subagent 是独立会话（header.origin='subagent'、parentSession=父会话），
   * 不是 HAMS 成员；团队页要看得见，就得把它登记成本项目的一条临时成员。
   * 同一个子会话只登记一次；子代理结束也不删，保留可追溯。
   */
  registerSubagent(input) {
    const childSessionId = String(input.childSessionId || "").trim();
    const parentSessionId = String(input.parentSessionId || "").trim();
    if (!childSessionId || !parentSessionId) return null;
    const mapped = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`subagent:session:${childSessionId}`);
    if (mapped) {
      try {
        const parsed = JSON.parse(mapped.value);
        if (typeof parsed.memberId === "string" && parsed.memberId) return { memberId: parsed.memberId };
      } catch {
      }
    }
    const project = this.projectRefOfSession(parentSessionId);
    if (!project) return null;
    const label = String(input.label || "").trim().slice(0, 40);
    const prompt = String(input.prompt || "").trim().slice(0, 8192);
    let name2 = label || `\u5B50\u4EE3\u7406 ${childSessionId.slice(0, 6)}`;
    const clash = this.db.prepare("SELECT 1 AS hit FROM member WHERE name = ?").get(name2);
    if (clash) name2 = `${name2.slice(0, 34)} \xB7 ${childSessionId.slice(0, 4)}`;
    const at = this.now();
    const memberId = this.id();
    this.db.prepare(
      `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                             owner_human_id, scope_project_id, created_at, updated_at)
         VALUES (?, 'bot', ?, NULL, ?, 'observer', 'active', 1, ?, ?, ?, ?)`
    ).run(memberId, name2, label, project.ownerHumanId, project.id, at, at);
    const digest = createHash10("sha256").update(`subagent
${childSessionId}
${label}`).digest("hex").slice(0, 16);
    this.db.prepare(
      `INSERT INTO member_version
           (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
            change_class, published_by, published_at)
         VALUES (?, ?, 1, ?, NULL, '{}', ?, ?, 'major', ?, ?)`
    ).run(this.id(), memberId, "hams-bot", prompt, digest, project.ownerHumanId, at);
    this.db.prepare(
      `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at)
         VALUES (?, ?, 'temp', ?, ?, ?)`
    ).run(project.id, memberId, `\u5B50\u4EE3\u7406 \xB7 ${label || childSessionId.slice(0, 6)}`, project.ownerHumanId, at);
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(
      `subagent:session:${childSessionId}`,
      JSON.stringify({ memberId, projectId: project.id })
    );
    this.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(
      `member:${memberId}:subagent`,
      childSessionId
    );
    return { memberId };
  }
  /** 由父会话反查项目：群会话索引 → 工作项线程 → 单聊后面挂的推进/参与项目。 */
  /** 和公开的 `projectOfSession`（只认群索引）区分：这里要把父会话反查成项目，含工作项线程与单聊。 */
  projectRefOfSession(sessionId) {
    if (!sessionId) return null;
    const groupProjectId = this.projectOfSession(sessionId);
    if (groupProjectId) {
      const row = this.db.prepare("SELECT id, owner_human_id FROM project WHERE id = ? AND deleted_at IS NULL").get(groupProjectId);
      if (row) return { id: row.id, ownerHumanId: row.owner_human_id };
    }
    const thread = this.db.prepare(
      `SELECT w.project_id AS projectId FROM work_item_thread t
           JOIN work_item w ON w.id = t.work_item_id
          WHERE t.session_id = ? AND w.project_id IS NOT NULL
          ORDER BY t.started_at DESC LIMIT 1`
    ).get(sessionId);
    if (thread) {
      const row = this.db.prepare("SELECT id, owner_human_id FROM project WHERE id = ? AND deleted_at IS NULL").get(thread.projectId);
      if (row) return { id: row.id, ownerHumanId: row.owner_human_id };
    }
    const chatMemberId = this.memberOfSession(sessionId);
    if (chatMemberId) {
      const coordinator = this.db.prepare("SELECT id, owner_human_id FROM project WHERE coordinator_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1").get(chatMemberId);
      if (coordinator) return { id: coordinator.id, ownerHumanId: coordinator.owner_human_id };
      const participant = this.db.prepare(
        `SELECT p.id, p.owner_human_id FROM project_participant pp JOIN project p ON p.id = pp.project_id
            WHERE pp.member_id = ? AND pp.removed_at IS NULL AND p.deleted_at IS NULL
            ORDER BY pp.added_at DESC LIMIT 1`
      ).get(chatMemberId);
      if (participant) return { id: participant.id, ownerHumanId: participant.owner_human_id };
    }
    return null;
  }
  subagentSessionOf(memberId) {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`member:${memberId}:subagent`);
    return row?.value || null;
  }
  /** 给早期登记（prompt 为空）的子代理补任务文本：新增一版配置，不改旧版本。 */
  backfillSubagentPrompt(memberId, prompt) {
    const text4 = String(prompt || "").trim().slice(0, 8192);
    if (!text4) return;
    const member = this.db.prepare("SELECT id, current_version, owner_human_id, status FROM member WHERE id = ?").get(memberId);
    if (!member || member.status === "retired") return;
    const current = this.db.prepare("SELECT * FROM member_version WHERE member_id = ? AND version = ?").get(memberId, member.current_version);
    if (!current || String(current.prompt || "").trim()) return;
    const at = this.now();
    const version = Number(member.current_version || 0) + 1;
    const digest = createHash10("sha256").update(`${memberId}
${text4}`).digest("hex").slice(0, 16);
    this.db.prepare(
      `INSERT INTO member_version
           (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
            change_class, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minor', ?, ?)`
    ).run(this.id(), memberId, version, current.agent_preset ?? "hams-bot", current.model ?? null, current.memory_scope_json ?? "{}", text4, digest, member.owner_human_id, at);
    this.db.prepare("INSERT INTO member_version_skill (member_version_id, skill_id, skill_version_id) SELECT ?, skill_id, skill_version_id FROM member_version_skill WHERE member_version_id = ?").run(
      this.id(),
      current.id
    );
    this.db.prepare("UPDATE member SET current_version = ?, updated_at = ? WHERE id = ?").run(version, at, memberId);
  }
  /** 轻量补登记：扫最近会话里 origin=subagent 且有 HAMS 父会话的，10 秒最多一次。 */
  async discoverSubagents() {
    if (!this.runtime.listSessions || !this.runtime.readSessionEvents) return;
    const now = this.now();
    if (now - this.lastSubagentScan < 1e4) return;
    this.lastSubagentScan = now;
    const sessions = await this.runtime.listSessions();
    const cutoff = now - 7 * 864e5;
    let budget = 40;
    for (const session of sessions) {
      if (!session || session.origin !== "subagent" || !session.parentSession) continue;
      if (!session.id || session.createdAt && session.createdAt < cutoff) continue;
      const known = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`subagent:session:${session.id}`);
      let knownMemberId = "";
      if (known) {
        try {
          knownMemberId = String(JSON.parse(known.value).memberId || "");
        } catch {
          knownMemberId = "";
        }
      }
      if (!knownMemberId) {
        if (!this.projectRefOfSession(session.parentSession)) continue;
        if (budget <= 0) break;
        budget -= 1;
      } else {
        const empty = this.db.prepare("SELECT 1 AS hit FROM member m JOIN member_version v ON v.member_id = m.id AND v.version = m.current_version WHERE m.id = ? AND v.prompt = ''").get(knownMemberId);
        if (!empty) continue;
      }
      let label = "";
      let prompt = "";
      try {
        const events = await this.runtime.readSessionEvents(session.id);
        const descriptor = events.find((event) => event && typeof event === "object" && event.type === "subagent/descriptor");
        label = typeof descriptor?.data?.label === "string" ? descriptor.data.label : "";
        prompt = subagentTaskPrompt(events, session.createdAt || 0);
      } catch {
        label = "";
      }
      if (knownMemberId) this.backfillSubagentPrompt(knownMemberId, prompt);
      else this.registerSubagent({ childSessionId: session.id, parentSessionId: session.parentSession, label, prompt });
    }
  }
  async team(ctx, input) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const project = this.projectRow(input.projectId);
    try {
      await this.discoverSubagents();
    } catch {
    }
    const rows = this.teamRows(input.projectId);
    const views = [];
    for (const row of rows) {
      const isCoordinator = row.kind === "coordinator";
      const pointer = this.pointerAt(this.groupKey(input.projectId, row.memberId, isCoordinator));
      const childSessionId = row.kind === "subagent" ? this.subagentSessionOf(row.memberId) : null;
      const dmSessionId = this.pointer("member", row.memberId)?.sessionId ?? null;
      const watchedSessionIds = [...new Set([pointer?.sessionId, dmSessionId, childSessionId].filter((id) => Boolean(id)))];
      let running = false;
      if (watchedSessionIds.length && this.runtime.available) {
        for (const sessionId of watchedSessionIds) {
          try {
            running = this.runtime.liveStatus ? this.runtime.liveStatus(sessionId).running : this.runtime.status ? (await this.runtime.status(sessionId)).running : false;
          } catch {
            running = false;
          }
          if (running) break;
        }
      }
      if (!running) {
        const activeRun = this.db.prepare("SELECT 1 AS hit FROM task_run WHERE member_id = ? AND status = 'running' LIMIT 1").get(row.memberId);
        running = Boolean(activeRun);
      }
      const watchedSessionId = watchedSessionIds[0] ?? null;
      views.push({
        memberId: row.memberId,
        name: row.name,
        kind: row.kind,
        status: row.status,
        brief: row.brief,
        sessionId: watchedSessionId,
        running
      });
    }
    const coordinator = views.find((row) => row.kind === "coordinator") ?? null;
    return { projectId: input.projectId, title: project.name, coordinator, members: views.filter((row) => row.kind !== "coordinator") };
  }
  /** 手动把在岗 bot 拉进项目群。重复加入是幂等的（撤销软删）。 */
  addParticipant(ctx, input) {
    this.requireProjectAdmin(ctx);
    const project = this.projectRow(input.projectId);
    if (project.status !== "active") throw new HamsError("STATE_INVALID", "\u5F52\u6863/\u6682\u505C\u7684\u9879\u76EE\u4E0D\u80FD\u518D\u52A0\u4EBA");
    if (project.coordinator_id === input.memberId) throw new HamsError("STATE_INVALID", "\u63A8\u8FDB bot \u5DF2\u7ECF\u5728\u7FA4\u91CC\u4E86");
    const bot = this.bot(input.memberId);
    const existing = this.participantRow(input.projectId, input.memberId);
    this.db.prepare(
      `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
         VALUES (?, ?, 'member', '', ?, ?, NULL, NULL)
         ON CONFLICT(project_id, member_id) DO UPDATE SET kind = 'member', removed_by = NULL, removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at`
    ).run(input.projectId, input.memberId, ctx.principalId, this.now());
    void existing;
    void bot;
    return { ok: true, memberId: input.memberId };
  }
  removeParticipant(ctx, input) {
    this.requireProjectAdmin(ctx);
    const project = this.projectRow(input.projectId);
    if (project.coordinator_id === input.memberId) throw new HamsError("STATE_INVALID", "\u63A8\u8FDB bot \u4E0D\u80FD\u4ECE\u7FA4\u91CC\u79FB\u9664\uFF1B\u6539\u9879\u76EE\u63A8\u8FDB bot \u8BF7\u8D70\u9879\u76EE\u8BBE\u7F6E");
    const row = this.participantRow(input.projectId, input.memberId);
    if (!row || row.removed_at) throw new HamsError("STATE_INVALID", "\u8FD9\u4E2A\u4EBA\u4E0D\u5728\u7FA4\u91CC");
    const at = this.now();
    this.db.prepare("UPDATE project_participant SET removed_at = ?, removed_by = ? WHERE project_id = ? AND member_id = ?").run(at, ctx.principalId, input.projectId, input.memberId);
    if (row.kind === "temp") {
      this.db.prepare("UPDATE member SET status = 'retired', updated_at = ? WHERE id = ? AND status = 'active'").run(at, input.memberId);
      void this.stopGroupSession(input.projectId, input.memberId, false);
    }
    return { ok: true };
  }
  async stopGroupSession(projectId, memberId, isCoordinator) {
    const pointer = this.pointerAt(this.groupKey(projectId, memberId, isCoordinator));
    if (!pointer || !this.runtime.available) return;
    try {
      await this.runtime.stop(pointer.sessionId);
    } catch {
    }
  }
  /**
   * 推进 bot 自己创建临时 bot：只属于这个项目群（member.scope_project_id），
   * 退休时随参与者一起下线。
   */
  spawnTempBot(ctx, input) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now());
    const project = this.projectRow(input.projectId);
    if (project.status !== "active") throw new HamsError("STATE_INVALID", "\u9879\u76EE\u4E0D\u5728\u8FDB\u884C\u4E2D\uFF0C\u4E0D\u80FD\u521B\u5EFA\u4E34\u65F6 bot");
    const isCoordinator = principal.kind === "bot" && project.coordinator_id === principal.memberId;
    if (principal.kind === "human") {
      requireCapability(principal, CAPABILITY.projectManage);
    } else if (!isCoordinator) {
      throw new HamsError("POLICY_DENIED", "\u53EA\u6709\u9879\u76EE\u63A8\u8FDB bot \u6216\u9879\u76EE\u7BA1\u7406\u5458\u80FD\u521B\u5EFA\u4E34\u65F6 bot", {
        nextStep: "\u8BA9\u63A8\u8FDB bot \u5728\u7FA4\u91CC\u81EA\u5DF1\u5EFA\uFF0C\u6216\u8BA9\u7BA1\u7406\u5458\u5728\u300C\u56E2\u961F\u300D\u91CC\u5EFA"
      });
    }
    const name2 = String(input.name || "").trim();
    if (!name2) throw new HamsError("STATE_INVALID", "\u4E34\u65F6 bot \u5FC5\u987B\u6709\u540D\u5B57");
    if (name2.length > 24) throw new HamsError("STATE_INVALID", "\u540D\u5B57\u6700\u591A 24 \u4E2A\u5B57");
    const brief = String(input.brief || "").trim().slice(0, 500);
    const at = this.now();
    const memberId = this.id();
    this.db.prepare(
      `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version, owner_human_id, scope_project_id, created_at, updated_at)
         VALUES (?, 'bot', ?, NULL, ?, 'executor', 'active', 1, ?, ?, ?, ?)`
    ).run(memberId, name2, brief, project.owner_human_id, project.id, at, at);
    const digest = createHash10("sha256").update(`${name2}
${brief}`).digest("hex").slice(0, 16);
    this.db.prepare(
      `INSERT INTO member_version (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest, change_class, published_by, published_at)
         VALUES (?, ?, 1, 'hams-bot', NULL, '{}', ?, ?, 'major', ?, ?)`
    ).run(this.id(), memberId, brief, digest, principal.memberId, at);
    const grant = this.db.prepare("INSERT OR IGNORE INTO member_permission (member_id, capability, scope, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)");
    for (const capability of ["work_item.execute", "work_item.claim", "evidence.append"]) {
      grant.run(memberId, capability, `project:${project.id}`, principal.memberId, at);
    }
    this.db.prepare(
      `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at)
         VALUES (?, ?, 'temp', ?, ?, ?)`
    ).run(project.id, memberId, brief, principal.memberId, at);
    return { memberId, name: name2 };
  }
  async groupRead(ctx, input) {
    resolvePrincipal(this.db, ctx.principalId, this.now());
    const project = this.projectRow(input.projectId);
    if (!this.runtime.available) {
      return { projectId: input.projectId, title: project.name, coordinator: null, members: [], messages: [], running: false, available: false, reason: this.runtime.unavailableReason };
    }
    await this.syncGroup(input.projectId);
    const team = await this.team(ctx, { projectId: input.projectId });
    const rows = this.db.prepare("SELECT * FROM project_message WHERE project_id = ? ORDER BY at, id LIMIT 400").all(input.projectId);
    const messages = rows.map((row) => ({
      id: row.id,
      authorKind: row.author_kind,
      authorId: row.author_id,
      authorName: row.author_name,
      text: row.text,
      at: row.at,
      kind: row.kind,
      toMemberId: row.to_member_id
    }));
    const last = messages[messages.length - 1];
    const coordinatorRow = this.db.prepare("SELECT coordinator_id FROM project WHERE id = ?").get(input.projectId);
    const coordinatorPointer = coordinatorRow.coordinator_id ? this.pointerAt(this.groupKey(input.projectId, coordinatorRow.coordinator_id, true)) : null;
    let error;
    if (coordinatorPointer) {
      try {
        const state = await this.runtime.read(coordinatorPointer.sessionId);
        error = state.error;
      } catch {
        error = void 0;
      }
    }
    return {
      projectId: input.projectId,
      title: project.name,
      coordinator: team.coordinator,
      members: team.members,
      messages,
      running: Boolean(team.coordinator?.running || team.members.some((row) => row.running)),
      available: true,
      ...error ? { error } : {}
    };
    void last;
  }
  /** 人往群里发一句话：默认交给推进 bot；它可以用 hams_group_send @ 具体成员。 */
  async groupSend(ctx, input) {
    this.human(ctx);
    this.requireRuntime();
    const text4 = String(input.text || "").trim();
    if (!text4) throw new HamsError("STATE_INVALID", "\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A");
    if (text4.length > 8e3) throw new HamsError("STATE_INVALID", "\u5355\u6761\u6D88\u606F\u4E0D\u80FD\u8D85\u8FC7 8000 \u5B57");
    const project = this.projectRow(input.projectId);
    if (!project.coordinator_id) throw new HamsError("STATE_INVALID", "\u8FD9\u4E2A\u9879\u76EE\u8FD8\u6CA1\u6709\u63A8\u8FDB bot\uFF0C\u7FA4\u804A\u6CA1\u6709\u56DE\u7B54\u7684\u4EBA", { nextStep: "\u5148\u5728\u9879\u76EE\u91CC\u6307\u5B9A\u63A8\u8FDB bot" });
    const human2 = this.memberRow(ctx.principalId);
    const humanName = human2?.name || ctx.principalId;
    const mentioned = this.mentionedMembers(input.projectId, text4, ctx.principalId);
    const targets = mentioned.length ? mentioned : [
      this.teamRows(input.projectId).find((row) => row.memberId === project.coordinator_id) ?? {
        memberId: project.coordinator_id,
        name: this.memberRow(project.coordinator_id)?.name || "\u63A8\u8FDB bot",
        kind: "coordinator",
        status: "active",
        brief: "\u9879\u76EE\u63A8\u8FDB bot"
      }
    ];
    const first = targets[0];
    const messageId = this.appendGroupMessage({
      projectId: input.projectId,
      authorKind: "human",
      authorId: ctx.principalId,
      authorName: humanName,
      text: text4,
      kind: mentioned.length ? "mention" : "chat",
      toMemberId: mentioned.length ? first.memberId : null
    });
    this.collectMemories(input.projectId, {
      id: messageId,
      authorKind: "human",
      authorId: ctx.principalId,
      authorName: humanName,
      text: text4
    });
    let intake = null;
    try {
      intake = await (this.intake?.registerFromMessage({
        projectId: input.projectId,
        senderId: ctx.principalId,
        text: text4,
        messageId,
        mentionedMemberId: mentioned.length ? first.memberId : null,
        recent: this.recentTranscript(input.projectId, 4)
      }) ?? null);
    } catch {
      intake = null;
    }
    const intakeNote = this.intakeNote(intake);
    if (intake) {
      this.appendGroupMessage({
        projectId: input.projectId,
        authorKind: "system",
        authorId: "system",
        authorName: "\u7CFB\u7EDF",
        text: this.intakeSystemText(intake),
        kind: "system"
      });
    }
    const sessionIds = [];
    for (const row of targets) {
      sessionIds.push(await this.deliverHumanMessage(project, row, text4, humanName, mentioned.length > 0, intakeNote));
    }
    return { messageId, sessionId: sessionIds[0], mentions: mentioned.map((row) => row.memberId) };
  }
  /**
   * 群里被 @ 的 bot：先看团队成员，再看全局在岗 bot。
   * @ 一个还没进群的 bot = 明确要它来排查，直接拉进群（人是发起者，写进参与者）。
   */
  mentionedMembers(projectId, text4, actorId) {
    const bots = this.db.prepare(
      `SELECT id AS memberId, name FROM member
          WHERE kind = 'bot' AND status = 'active'
            AND (scope_project_id IS NULL OR scope_project_id = ?)
          ORDER BY length(name) DESC, name`
    ).all(projectId);
    let rest = text4;
    const hits = [];
    for (const bot of bots) {
      const token = new RegExp(`[@\uFF20]\\s*${escapeRegExp(bot.name)}`);
      if (!token.test(rest)) continue;
      hits.push(bot.memberId);
      rest = rest.replace(new RegExp(`[@\uFF20]\\s*${escapeRegExp(bot.name)}`, "g"), "@");
    }
    if (!hits.length) return [];
    for (const memberId of hits) {
      const member = this.teamRows(projectId).find((row) => row.memberId === memberId);
      if (!member) {
        this.db.prepare(
          `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
             VALUES (?, ?, 'member', '\u88AB @ \u62C9\u8FDB\u7FA4', ?, ?, NULL, NULL)
             ON CONFLICT(project_id, member_id) DO UPDATE SET removed_by = NULL, removed_at = NULL`
        ).run(projectId, memberId, actorId, this.now());
      }
    }
    const team = this.teamRows(projectId);
    return hits.map((memberId) => team.find((row) => row.memberId === memberId)).filter((row) => Boolean(row));
  }
  /**
   * 群聊里的自动记忆收集：规则提取候选，写进项目记忆；真的新增了才在群里留一条系统记录。
   * 只处理真人和 bot 的发言，不处理系统记录，避免自我循环。
   */
  collectMemories(projectId, message) {
    try {
      const candidates = extractMemoryCandidates(message.text, {
        authorKind: message.authorKind,
        authorId: message.authorId,
        authorName: message.authorName
      });
      if (!candidates.length) return 0;
      const created = [];
      candidates.forEach((candidate, index) => {
        const result = createMemory(this.db, this.id, this.now(), message.authorId, {
          projectId,
          kind: candidate.kind,
          title: candidate.title,
          body: candidate.body,
          origin: "auto",
          memberId: candidate.memberId,
          sourceRef: `message:${message.id}`,
          dedupeKey: `auto:${message.id}:${index}`
        });
        if (result.created) created.push(candidate);
      });
      if (!created.length) return 0;
      this.appendGroupMessage({
        projectId,
        authorKind: "system",
        authorId: "system",
        authorName: "\u8BB0\u5FC6",
        text: `\u81EA\u52A8\u6536\u96C6 ${created.length} \u6761\u8BB0\u5FC6\uFF1A${created.map((candidate) => `[${MEMORY_KIND_LABEL[candidate.kind]}] ${candidate.title}`).join("\uFF1B")}`,
        kind: "system"
      });
      return created.length;
    } catch {
      return 0;
    }
  }
  /** 工具路径：bot 主动把项目里值得记住的内容写进记忆；能力类默认同步给发言的 bot。 */
  rememberBySession(sessionId, input) {
    const projectId = this.projectOfSession(sessionId);
    const speakerId = this.memberOfSession(sessionId);
    if (!projectId || !speakerId) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u5728\u4EFB\u4F55\u9879\u76EE\u7FA4\u91CC", { nextStep: "\u9879\u76EE\u8BB0\u5FC6\u53EA\u80FD\u5728\u9879\u76EE\u7FA4\u91CC\u8BB0\u5F55" });
    const kind = String(input.kind || "fact");
    const memberId = kind === "capability" ? input.botId || speakerId : null;
    const result = createMemory(this.db, this.id, this.now(), speakerId, {
      projectId,
      kind,
      title: input.title,
      body: input.body,
      origin: "tool",
      memberId,
      sourceRef: `tool:${sessionId.slice(-8)}`
    });
    return { ok: true, memoryId: result.memory.id, created: result.created, syncedTo: result.syncedTo };
  }
  async deliverHumanMessage(project, row, text4, humanName, mentioned, intakeNote = "") {
    if (row.status !== "active") {
      throw new HamsError("STATE_INVALID", `${row.name} \u5F53\u524D\u4E0D\u5728\u5C97\uFF0C\u63A5\u4E0D\u4E86\u8FD9\u6761\u6307\u4EE4`, { nextStep: "\u5728\u667A\u80FD\u4F53\u8BE6\u60C5\u91CC\u6062\u590D\u5B83\u5728\u5C97\uFF0C\u6216\u6362\u4E00\u4E2A bot" });
    }
    const member = this.bot(row.memberId);
    const isCoordinator = project.coordinator_id === row.memberId;
    const roster = this.rosterText(project.id);
    const context = isCoordinator ? this.coordinatorContext(project, roster) : this.memberContext(project, roster);
    const { sessionId } = await this.ensureGroupSession(project, member, isCoordinator, context);
    const transcript = this.recentTranscript(project.id, 10);
    const prefix = mentioned ? `[\u4EBA\u7C7B ${humanName} @\u4F60]` : `[\u4EBA\u7C7B ${humanName}]`;
    const instruction = isCoordinator ? "\uFF08\u4F60\u662F\u63A8\u8FDB bot\u3002\u6D3E\u6D3B\u5FC5\u987B\u7528 hams_group_send\uFF0C\u5E76\u5728 text \u5F00\u5934\u5199\u300C@\u6210\u5458\u540D\u300D\uFF0C\u8BA9\u7FA4\u91CC\u770B\u5F97\u89C1\u4F60\u70B9\u4E86\u8C01\uFF1B\u7CFB\u7EDF\u5DF2\u767B\u8BB0\u5DE5\u4F5C\u9879\u65F6\u76F4\u63A5\u7528\u5B83\u7684 id \u6D3E\u7ED9\u6210\u5458\uFF1B\u7CFB\u7EDF\u6CA1\u767B\u8BB0\u3001\u4F60\u5224\u65AD\u662F\u65B0\u6D3B\u65F6\u624D\u7528 hams_create_work_item \u8865\u5EFA\uFF1B\u81EA\u5DF1\u7684\u5224\u65AD\u53EF\u4EE5\u76F4\u63A5\u56DE\u7B54\uFF0C\u4E0D\u8981@\u4E0D\u5B58\u5728\u7684\u4EBA\uFF1B\u5173\u5355\u4E0E\u5BA1\u6279\u53EA\u80FD\u7531\u4EBA\u505A\u3002\uFF09" : "\uFF08\u4F60\u88AB\u4EBA\u7C7B\u70B9\u540D\u4E86\u3002\u76F4\u63A5\u56DE\u7B54\u8FD9\u6761\u6307\u4EE4\uFF1B\u9700\u8981\u522B\u4EBA\u7EE7\u7EED\u7528 hams_group_send\uFF1B\u5173\u5355\u4E0E\u5BA1\u6279\u53EA\u80FD\u7531\u4EBA\u505A\uFF0C\u4E0D\u8981\u7F16\u9020\u6CA1\u8BB0\u5F55\u8FC7\u7684\u4E8B\u3002\uFF09";
    const memory = projectMemoryBlock(this.db, project.id);
    await this.runtime.send(
      sessionId,
      `${roster}

${memory ? `${memory}

` : ""}\u3010\u7FA4\u804A\u6700\u8FD1\u8BB0\u5F55\u3011
${transcript}

${intakeNote}${prefix} ${text4}

${instruction}`
    );
    return sessionId;
  }
  coordinatorContext(project, roster) {
    return `\u4F60\u5728 HAMS \u9879\u76EE\u300A${project.name}\u300B\uFF08projectId=${project.id}\uFF09\u7684\u7FA4\u804A\u91CC\uFF0C\u662F\u8FD9\u4E2A\u9879\u76EE\u7684\u63A8\u8FDB bot\u3002
${roster}
\u4F60\u53EF\u4EE5\uFF1A\u770B\u9879\u76EE\u5DE5\u4F5C\u9879\uFF08hams_list_project_work\uFF09\u3001\u5728\u672C\u9879\u76EE\u5EFA\u5DE5\u4F5C\u9879\uFF08hams_create_work_item\uFF0CprojectId \u7528\u4E0A\u9762\u7684\uFF09\u3001\u6307\u6D3E\u4EFB\u52A1\uFF08hams_assign_task\uFF09\u3001@ \u7FA4\u6210\u5458\uFF08hams_group_send \u5E26 memberId\uFF09\u3001\u5EFA\u4E34\u65F6 bot\uFF08hams_group_spawn_bot\uFF0C\u53EA\u5C5E\u4E8E\u8FD9\u4E2A\u9879\u76EE\u7FA4\uFF09\u3001\u8BB0\u9879\u76EE\u8BB0\u5FC6\uFF08hams_remember\uFF09\u3002\u5173\u5355\u4E0E\u5BA1\u6279\u53EA\u80FD\u7531\u4EBA\u505A\u3002\u7528\u4E2D\u6587\u7B80\u77ED\u56DE\u7B54\u3002
\u4EBA\u7C7B\u7684\u65B0\u6D3B\u4F1A\u7531\u7CFB\u7EDF\u81EA\u52A8\u767B\u8BB0\u6210\u5DE5\u4F5C\u9879\uFF0C\u6D88\u606F\u91CC\u4F1A\u7ED9\u51FA\u5DE5\u4F5C\u9879 id\uFF1B\u4F18\u5148\u7528\u90A3\u6761\u5DE5\u4F5C\u9879\u6D3E\u6D3B\u3002\u53EA\u6709\u7CFB\u7EDF\u6CA1\u767B\u8BB0\u3001\u800C\u4F60\u8BA4\u4E3A\u786E\u5B9E\u8FD8\u7F3A\u4E00\u6761\u65F6\uFF0C\u624D\u7528 hams_create_work_item \u8865\u5EFA\uFF08\u540C\u6807\u9898\u81EA\u52A8\u53BB\u91CD\uFF09\u3002
\u9047\u5230\u51B3\u5B9A\u3001\u504F\u597D\u3001\u6559\u8BAD\u3001\u53E3\u5F84\u6216 bot \u80FD\u529B\u7ECF\u9A8C\uFF0C\u7528 hams_remember \u8BB0\u4E0B\u6765\uFF1B\u80FD\u529B\u7C7B\u4F1A\u540C\u6B65\u7ED9\u5BF9\u5E94 bot\u3002
` + (projectMemoryBlock(this.db, project.id) ? `${projectMemoryBlock(this.db, project.id)}
` : "") + "\u786C\u89C4\u5219\uFF1A\u6D3E\u6D3B\u7ED9\u8C01\uFF0C\u5C31\u5728\u7FA4\u804A\u6B63\u6587\u91CC\u5199\u51FA\u300C@\u540D\u5B57\u300D\uFF1Bhams_group_send \u4F1A\u81EA\u52A8\u8865\u4E0A\u5F00\u5934\u7684 @\u540D\u5B57\uFF0C\u6240\u4EE5\u8C03\u7528\u5B83\u65F6 text \u76F4\u63A5\u5199\u4EFB\u52A1\u5185\u5BB9\u5373\u53EF\uFF0C\u4F46\u6700\u7EC8\u7FA4\u91CC\u5FC5\u987B\u80FD\u770B\u5230\u4F60\u70B9\u4E86\u8C01\u3002";
  }
  memberContext(project, roster) {
    return `\u4F60\u5728 HAMS \u9879\u76EE\u300A${project.name}\u300B\u7684\u7FA4\u804A\u91CC\uFF0C\u662F\u7FA4\u91CC\u7684\u4E00\u540D bot \u6210\u5458\u3002
${roster}
\u88AB @ \u65F6\u4F60\u4F1A\u6536\u5230\u5E26\u4E0A\u4E0B\u6587\u7684\u6307\u4EE4\uFF1B\u56DE\u590D\u76F4\u63A5\u8BF4\u8BDD\u5373\u53EF\uFF0C\u4F1A\u88AB\u5408\u5E76\u8FDB\u7FA4\u804A\u8BB0\u5F55\u3002\u9700\u8981\u5176\u4ED6\u6210\u5458\u65F6\u7528 hams_group_send\uFF0C\u6B63\u6587\u540C\u6837\u8981\u5199\u51FA\u300C@\u540D\u5B57\u300D\u3002\u7CFB\u7EDF\u4F1A\u81EA\u52A8\u767B\u8BB0\u65B0\u6D3B\uFF1B\u9700\u8981\u989D\u5916\u5EFA\u4EFB\u52A1\u65F6\u7528 hams_create_work_item\uFF08\u6709\u6743\u9650\u65F6\uFF09\u6216\u8BF7\u63A8\u8FDB bot \u5EFA\u5355\uFF1B\u4E0D\u8981\u66FF\u63A8\u8FDB bot \u6D3E\u6D3B\uFF0C\u4E5F\u4E0D\u8981\u6279\u51C6\u5173\u5355\u3002` + (projectMemoryBlock(this.db, project.id) ? `
${projectMemoryBlock(this.db, project.id)}` : "");
  }
  /** 工具路径：以某个会话的身份在群里发言（@ 某个成员）。 */
  async groupSpeakBySession(sessionId, input) {
    const projectId = this.projectOfSession(sessionId);
    const speakerId = this.memberOfSession(sessionId);
    if (!projectId || !speakerId) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u5728\u4EFB\u4F55\u9879\u76EE\u7FA4\u91CC", { nextStep: "\u7FA4\u804A\u53EA\u80FD\u5728\u9879\u76EE\u7FA4\u4F1A\u8BDD\u91CC\u7528" });
    const project = this.projectRow(projectId);
    const speaker = this.memberRow(speakerId);
    if (!speaker) throw new HamsError("STATE_INVALID", "\u7FA4\u4F1A\u8BDD\u7684\u6210\u5458\u4E0D\u5B58\u5728");
    const isCoordinator = project.coordinator_id === speakerId;
    const isMember = Boolean(this.participantRow(projectId, speakerId) && !this.participantRow(projectId, speakerId).removed_at);
    if (!isCoordinator && !isMember) throw new HamsError("POLICY_DENIED", "\u4F60\u4E0D\u5728\u8FD9\u4E2A\u9879\u76EE\u7FA4\u91CC", { nextStep: "\u8BA9\u7BA1\u7406\u5458\u628A\u4F60\u52A0\u8FDB\u9879\u76EE\u56E2\u961F" });
    if (!input.toMemberId) throw new HamsError("STATE_INVALID", "\u8981 @ \u8C01\uFF1F\u8BF7\u7ED9\u51FA memberId\uFF08\u5148\u7528 hams_group_members \u67E5\uFF09");
    const target = this.teamRows(projectId).find((row) => row.memberId === input.toMemberId);
    if (!target) throw new HamsError("STATE_INVALID", `${input.toMemberId} \u4E0D\u5728\u8FD9\u4E2A\u9879\u76EE\u7FA4\u91CC`, { nextStep: "\u5148\u7528 hams_group_members \u770B\u6709\u8C01" });
    const raw = String(input.text || "").trim();
    if (!raw) throw new HamsError("STATE_INVALID", "\u8981\u8BF4\u7684\u8BDD\u4E0D\u80FD\u4E3A\u7A7A");
    const atPrefix = `@${target.name}`;
    const text4 = raw.startsWith(atPrefix) ? raw : `${atPrefix} ${raw}`;
    const messageId = this.appendGroupMessage({
      projectId,
      authorKind: "bot",
      authorId: speakerId,
      authorName: speaker.name,
      text: text4,
      kind: "mention",
      toMemberId: input.toMemberId
    });
    this.collectMemories(projectId, {
      id: messageId,
      authorKind: "bot",
      authorId: speakerId,
      authorName: speaker.name,
      text: text4
    });
    const targetMember = this.bot(input.toMemberId);
    const roster = this.rosterText(projectId);
    const { sessionId: targetSession } = await this.ensureGroupSession(project, targetMember, false, this.memberContext(project, roster));
    const transcript = this.recentTranscript(projectId, 10);
    const memory = projectMemoryBlock(this.db, projectId);
    await this.runtime.send(
      targetSession,
      `${roster}

${memory ? `${memory}

` : ""}\u3010\u7FA4\u804A\u6700\u8FD1\u8BB0\u5F55\u3011
${transcript}

[${speaker.name} @\u4F60] ${text4}

\uFF08\u5728\u7FA4\u804A\u91CC\u56DE\u590D\u5373\u53EF\uFF1B\u9700\u8981\u522B\u4EBA\u7EE7\u7EED\u7528 hams_group_send\u3002\u4E0D\u8981\u7F16\u9020\u6CA1\u8BB0\u5F55\u8FC7\u7684\u4E8B\u3002\uFF09`
    );
    return { ok: true, messageId };
  }
  /**
   * 工具路径：推进 bot 指派工作项后，在群里留一条可见的「@接活人」记录。
   * 只写合并记录，不再唤醒被指派人（真正开跑由会话适配器派发）。
   */
  groupNoteAssignmentBySession(sessionId, input) {
    const projectId = this.projectOfSession(sessionId);
    const speakerId = this.memberOfSession(sessionId);
    if (!projectId || !speakerId) return null;
    const project = this.projectRow(projectId);
    if (project.coordinator_id !== speakerId) return null;
    const speaker = this.memberRow(speakerId);
    if (!speaker) return null;
    const body = String(input.text || "").trim();
    if (!body) return null;
    let target = this.teamRows(projectId).find((row) => row.memberId === input.memberId);
    if (!target) {
      const member = this.memberRow(input.memberId);
      if (!member || member.kind !== "bot" || member.status !== "active") return null;
      this.db.prepare(
        `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
           VALUES (?, ?, 'member', '\u88AB\u6307\u6D3E\u52A0\u5165', ?, ?, NULL, NULL)
           ON CONFLICT(project_id, member_id) DO UPDATE SET removed_by = NULL, removed_at = NULL`
      ).run(projectId, member.id, speakerId, this.now());
      target = this.teamRows(projectId).find((row) => row.memberId === input.memberId);
      if (!target) return null;
    }
    const text4 = body.startsWith(`@${target.name}`) ? body : `@${target.name} ${body}`;
    const messageId = this.appendGroupMessage({
      projectId,
      authorKind: "bot",
      authorId: speakerId,
      authorName: speaker.name,
      text: text4,
      kind: "mention",
      toMemberId: target.memberId
    });
    return { ok: true, messageId };
  }
  /** 工具路径：推进 bot 建临时 bot（只属于本群）。 */
  groupSpawnBySession(sessionId, input) {
    const projectId = this.projectOfSession(sessionId);
    const speakerId = this.memberOfSession(sessionId);
    if (!projectId || !speakerId) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u5728\u4EFB\u4F55\u9879\u76EE\u7FA4\u91CC");
    const project = this.projectRow(projectId);
    if (project.coordinator_id !== speakerId) throw new HamsError("POLICY_DENIED", "\u53EA\u6709\u63A8\u8FDB bot \u80FD\u5728\u81EA\u5DF1\u7FA4\u91CC\u5EFA\u4E34\u65F6 bot");
    return this.spawnTempBot({ principalId: speakerId, channel: "tool", correlationId: `group-spawn-${this.now()}` }, { projectId, ...input });
  }
  /** 工具路径：群成员名单。 */
  groupMembersBySession(sessionId) {
    const projectId = this.projectOfSession(sessionId);
    if (!projectId) throw new HamsError("POLICY_DENIED", "\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u5728\u4EFB\u4F55\u9879\u76EE\u7FA4\u91CC");
    return this.teamRows(projectId);
  }
  projectOfSession(sessionId) {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:group:session:${sessionId}`);
    return row?.value || null;
  }
  memberOfSession(sessionId) {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:session:${sessionId}`);
    return row?.value || null;
  }
};

// src/host/chat-runtime.ts
import path7 from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/host/bot-preset.ts
import { createHash as createHash11 } from "node:crypto";
var HAMS_BOT_PRESET = "hams-bot";
var PLAN_MODE_SECTION = String.raw`You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;
var HAMS_PERSONA_BASE = "You are a HAMS work-item agent. Facts about the work item come from the HAMS tools; never invent state or close a work item yourself. Answer the human in Chinese, briefly. When the human is chatting in a project group, you are the coordinator: you may break work into tasks and assign them to other bots via the HAMS tools. When a concrete deliverable is requested, register it as a HAMS work item with hams_create_work_item before doing the work; never just promise in chat without creating the item.";
var STANDARD_TOOL_PLUGINS = [
  {
    id: "agent-instructions",
    name: "@deepseek-ai/dsh-agent-instructions",
    config: { maxBytes: 65536 }
  },
  { id: "time-context", name: "@deepseek-ai/dsh-time-context" },
  { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
  {
    id: "tool-fs",
    name: "@deepseek-ai/dsh-tool-fs",
    config: { applyPatch: false }
  },
  {
    id: "tool-fs-search",
    name: "@deepseek-ai/dsh-tool-fs-search",
    config: { sampleOverCapGlobResults: false }
  },
  { id: "tool-jobs", name: "@deepseek-ai/dsh-tool-jobs" },
  { id: "tool-schedule", name: "@deepseek-ai/dsh-tool-schedule" },
  { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
  { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
  { id: "command-goal", name: "@deepseek-ai/dsh-command-goal" },
  { id: "tool-goal", name: "@deepseek-ai/dsh-tool-goal" },
  {
    id: "planning",
    name: "cordis:group",
    group: true,
    isolate: { planMode: true },
    config: [{ id: "plan-mode", name: "@deepseek-ai/dsh-plan-mode", config: { section: PLAN_MODE_SECTION } }]
  },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
      { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
      {
        id: "tool-result-pruner",
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
      }
    ]
  },
  {
    id: "delegation",
    name: "cordis:group",
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: "tool-subagent-control", name: "@deepseek-ai/dsh-tool-subagent-control" },
      {
        id: "tool-subagent",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: { provider: "spawn", toolName: "subagent", modelSelection: true, modelDiscovery: true }
      },
      { id: "tool-subagent-fork", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "fork", toolName: "subagent_fork" } },
      { id: "workflow-ptc", name: "@deepseek-ai/dsh-workflow-ptc", config: { provider: "spawn" } },
      { id: "tool-workflow", name: "@deepseek-ai/dsh-tool-workflow" }
    ]
  },
  { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
  { id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } },
  { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: true, searchTimeoutMs: 6e4 } },
  { id: "present", name: "@deepseek-ai/dsh-tool-present" }
];
function templateSafe(text4) {
  return text4.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
}
function hamsPersonaPrefix(prompt) {
  const text4 = String(prompt || "").trim();
  if (!text4) return HAMS_PERSONA_BASE;
  return `${HAMS_PERSONA_BASE}

\u3010\u4F60\u7684\u8BBE\u5B9A\uFF08\u7531\u6210\u5458\u914D\u7F6E\u53D1\u5E03\uFF1B\u4E0E\u4E0A\u9762\u7684\u901A\u7528\u8BF4\u660E\u51B2\u7A81\u65F6\u4EE5\u8FD9\u91CC\u4E3A\u51C6\uFF09\u3011
${templateSafe(text4)}`;
}
function presetSafeId(value) {
  return String(value || "bot").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "bot";
}
function botPresetId(memberId, version, prompt) {
  const digest = createHash11("sha256").update(String(prompt || "")).digest("hex").slice(0, 8);
  return `${HAMS_BOT_PRESET}-${presetSafeId(memberId)}-v${Number(version) || 0}-${digest}`;
}
function hamsBotPresetDefinition(options = {}) {
  const id = options.id || HAMS_BOT_PRESET;
  const perBot = Boolean(String(options.prompt || "").trim());
  return {
    id,
    name: perBot ? `HAMS bot \xB7 ${options.memberName || id}` : "HAMS bot",
    description: perBot ? "HAMS \u5DE5\u4F5C\u9879/\u7FA4\u804A\u6267\u884C\u4F53\uFF1A\u5DE5\u5177\u4E0E\u5B98\u65B9 standard preset \u5BF9\u9F50\uFF0C\u4EBA\u8BBE\u6765\u81EA\u8FD9\u4E2A bot \u7684\u63D0\u793A\u8BCD" : "HAMS \u5DE5\u4F5C\u9879/\u7FA4\u804A\u6267\u884C\u4F53\uFF1A\u5DE5\u5177\u4E0E\u5B98\u65B9 standard preset \u5BF9\u9F50\uFF08bash / \u6587\u4EF6 / subagent / \u8054\u7F51 / \u6280\u80FD / \u4EA4\u4ED8\u5361\u7247\uFF09",
    order: 90,
    plugins: [
      {
        id: "persona",
        name: "@deepseek-ai/dsh-persona",
        config: { prefix: hamsPersonaPrefix(options.prompt) }
      },
      ...STANDARD_TOOL_PLUGINS
    ]
  };
}
function registryOf(ctx) {
  try {
    const found = ctx.get ? ctx.get("agentPresets") : void 0;
    return found && typeof found === "object" ? found : void 0;
  } catch {
    return void 0;
  }
}
var registered = /* @__PURE__ */ new Set();
var pending = /* @__PURE__ */ new Map();
async function registerPreset(ctx, definition, log) {
  const note = log || (() => {
  });
  if (registered.has(definition.id)) return definition.id;
  const registry = registryOf(ctx);
  if (!registry) return null;
  try {
    const list = await registry.list();
    if (Array.isArray(list) && list.some((row) => row && row.id === definition.id)) {
      const resolved2 = await registry.resolve(definition.id);
      if (resolved2 && resolved2.broken) {
        note(`[hams] agent preset ${definition.id} \u4E0D\u53EF\u7528\uFF1A${resolved2.broken}`);
        return null;
      }
      registered.add(definition.id);
      return definition.id;
    }
    await registry.register(definition);
    const resolved = await registry.resolve(definition.id);
    if (resolved && resolved.broken) {
      note(`[hams] agent preset ${definition.id} \u4E0D\u53EF\u7528\uFF1A${resolved.broken}`);
      return null;
    }
    registered.add(definition.id);
    note(`[hams] \u5DF2\u6CE8\u518C agent preset ${definition.id}`);
    return definition.id;
  } catch (error) {
    note(`[hams] \u6CE8\u518C ${definition.id} \u5931\u8D25\uFF0C\u9000\u56DE\u5BBF\u4E3B\u9ED8\u8BA4 preset\uFF1A${String(error)}`);
    return null;
  }
}
function resolveBotPreset(ctx, input, log) {
  const requested = String(input.preset || "").trim();
  if (requested && requested !== HAMS_BOT_PRESET) return Promise.resolve(requested);
  const id = botPresetId(input.memberId, input.version, input.prompt);
  const existing = pending.get(id);
  if (existing) return existing;
  const definition = hamsBotPresetDefinition({ id, memberName: input.memberName, prompt: input.prompt });
  const task = registerPreset(ctx, definition, log).finally(() => {
    pending.delete(id);
  });
  pending.set(id, task);
  return task;
}

// src/host/chat-runtime.ts
function chatMessagesFromEvents(events) {
  const messages = [];
  const openTurns = /* @__PURE__ */ new Set();
  let running = false;
  let lastError;
  const text4 = (content) => {
    if (!Array.isArray(content)) return "";
    return content.filter((block2) => block2 && typeof block2 === "object" && block2.type === "text" && typeof block2.text === "string").map((block2) => String(block2.text)).join("\n").trim();
  };
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw;
    if (event.surfaceOp !== void 0 && event.surfaceOp !== "append") continue;
    const data = event.data || {};
    if (event.type === "turn/start") {
      const turn = Number(data.turn);
      if (Number.isFinite(turn)) openTurns.add(turn);
      running = true;
      lastError = void 0;
      continue;
    }
    if (event.type === "turn/end") {
      const turn = Number(data.turn);
      if (Number.isFinite(turn)) openTurns.delete(turn);
      running = openTurns.size > 0;
      const reason = data.reason;
      if (reason && reason.kind === "error") {
        const message = reason.error && typeof reason.error.message === "string" ? reason.error.message : "";
        lastError = message || "\u8FD9\u4E00\u8F6E\u6267\u884C\u5931\u8D25\uFF08\u5BBF\u4E3B\u6CA1\u6709\u7ED9\u51FA\u539F\u56E0\uFF09";
      }
      continue;
    }
    if (event.type === "user/message") {
      const source = data.source;
      if (!source || source.kind !== "user") continue;
      const body = text4(data.content);
      if (!body) continue;
      messages.push({ id: String(data.id || `u-${messages.length}`), role: "user", text: body, at: Number(event.time) || 0, seq: Number(event.seq) || 0 });
      continue;
    }
    if (event.type === "assistant/message") {
      const message = data.message;
      const body = text4(message && message.content);
      if (!body) continue;
      messages.push({ id: String(message && message.id || `a-${messages.length}`), role: "assistant", text: body, at: Number(event.time) || 0, seq: Number(event.seq) || 0 });
    }
  }
  return { messages, running: running && openTurns.size > 0, ...lastError ? { error: lastError } : {} };
}
async function resolveAgentOptions(choice, llmService, fallback) {
  const parsed = await parseModelChoice(choice, llmService, fallback?.provider);
  if (parsed?.model) return parsed;
  if (!fallback?.provider || !fallback.model) return void 0;
  return {
    provider: String(fallback.provider),
    model: String(fallback.model),
    ...fallback.reasoningEffort ? { reasoningEffort: String(fallback.reasoningEffort) } : {}
  };
}
async function parseModelChoice(value, llmService, fallbackProvider) {
  const raw = (value || "").trim();
  if (!raw) return void 0;
  let providerIds = [];
  if (llmService) {
    try {
      providerIds = llmService.listProviders().map((row) => row.id);
    } catch {
      providerIds = [];
    }
  }
  if (llmService && providerIds.length) {
    for (const provider of providerIds) {
      try {
        const models = await llmService.listModels(provider);
        if (models.some((row) => row.id === raw)) return { provider, model: raw };
      } catch {
      }
    }
    const longestFirst = [...providerIds].sort((a, b) => b.length - a.length);
    for (const provider of longestFirst) {
      if (raw.startsWith(`${provider}/`)) return { provider, model: raw.slice(provider.length + 1) };
    }
  }
  return { provider: fallbackProvider, model: raw };
}
function safeSegment(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
function createHostChatRuntime(options) {
  const { ctx, dataDir } = options;
  const log = options.log || (() => {
  });
  const handles = /* @__PURE__ */ new Map();
  const openings = /* @__PURE__ */ new Map();
  const meta = /* @__PURE__ */ new Map();
  const contextSent = /* @__PURE__ */ new Set();
  let modelsCache = null;
  let closed = false;
  const service = (name2) => {
    if (typeof ctx.get !== "function") return void 0;
    try {
      const found = ctx.get(name2);
      return found && typeof found === "object" ? found : void 0;
    } catch {
      return void 0;
    }
  };
  const agents = () => service("agents");
  const sessionQuery = () => service("sessionQuery");
  const presets = () => service("agentPresets");
  const llm = () => service("llm");
  const defaultModelService = () => service("agentDefaultModel");
  function sendContext(handle, sessionId, context) {
    if (!context || contextSent.has(sessionId) || typeof handle.agent.inject !== "function") return;
    try {
      handle.agent.inject({
        id: `msg-${randomUUID2()}`,
        role: "user",
        content: [{ type: "text", text: context }],
        source: { kind: "hams-chat-context", form: "instructions" }
      });
      contextSent.add(sessionId);
    } catch (error) {
      log(`[hams] \u6CE8\u5165\u5BF9\u8BDD\u4E0A\u4E0B\u6587\u5931\u8D25\uFF1A${String(error)}`);
    }
  }
  async function openSession(input) {
    const registry = agents();
    if (!registry) throw new Error("\u5BBF\u4E3B\u6CA1\u6709 agents \u670D\u52A1");
    const parsedModel = await resolveAgentOptions(input.model, llm(), defaultModelService()?.currentSelection?.());
    if (!parsedModel) throw new Error("\u8FD9\u4E2A bot \u6CA1\u6709\u914D\u7F6E\u6A21\u578B\uFF0C\u5BBF\u4E3B\u4E5F\u6CA1\u6709\u9ED8\u8BA4\u6A21\u578B\uFF1B\u8BF7\u7ED9 bot \u9009\u4E00\u4E2A\u6A21\u578B\u6216\u8BBE\u7F6E\u5BBF\u4E3B\u9ED8\u8BA4\u6A21\u578B");
    const agentOptions = Object.fromEntries(Object.entries(parsedModel).filter(([, value]) => value !== void 0 && value !== ""));
    const presetId = await resolveBotPreset(ctx, {
      memberId: input.memberId,
      memberName: input.memberName,
      version: input.memberVersion,
      prompt: input.prompt,
      preset: input.preset
    }, log);
    const cwd = path7.resolve(dataDir, "bots", input.memberId, "chats", safeSegment(input.cwdKey || "default"));
    const base = path7.resolve(dataDir, "bots") + path7.sep;
    if (!cwd.startsWith(base)) throw new Error("bot \u5DE5\u4F5C\u76EE\u5F55\u8D8A\u754C");
    await mkdir(cwd, { recursive: true });
    const meta2 = { cwd, ...presetId ? { agentPreset: presetId } : {} };
    const registryPresets = presets();
    const setup = presetId && registryPresets && typeof registryPresets.mount === "function" ? async (agentCtx) => {
      await registryPresets.mount(agentCtx, presetId);
    } : void 0;
    if (input.sessionId) {
      const handle2 = await registry.resume({ resumeSessionId: input.sessionId, agentOptions, ...setup ? { setup } : {} });
      sendContext(handle2, input.sessionId, input.context);
      return handle2;
    }
    const sessionId = `hams-${input.memberId}-${Date.now().toString(36)}-${randomUUID2().slice(0, 8)}`;
    const handle = await registry.create({ sessionId, meta: meta2, agentOptions, ...setup ? { setup } : {} });
    sendContext(handle, sessionId, input.context);
    return handle;
  }
  function handleFor(sessionId, input) {
    const existing = handles.get(sessionId);
    if (existing) return existing;
    const pending2 = openings.get(sessionId);
    if (pending2) return pending2;
    const opening = openSession({ sessionId, ...input });
    openings.set(sessionId, opening);
    return opening.then((handle) => {
      handles.set(sessionId, Promise.resolve(handle));
      return handle;
    }).finally(() => {
      openings.delete(sessionId);
    });
  }
  const runtime = {
    get available() {
      return Boolean(agents());
    },
    get unavailableReason() {
      return agents() ? void 0 : "\u5BBF\u4E3B\u6CA1\u6709 agents \u670D\u52A1\uFF08\u53EA\u8BFB\u5B9E\u4F8B\u6216\u6CA1\u6709 agent \u8FD0\u884C\u65F6\uFF09";
    },
    async ensure(input) {
      if (closed) throw new Error("\u5BF9\u8BDD\u8FD0\u884C\u65F6\u5DF2\u505C\u6B62");
      const info = {
        memberId: input.memberId,
        memberName: input.memberName,
        memberVersion: input.memberVersion,
        prompt: input.prompt || "",
        preset: input.agentPreset || HAMS_BOT_PRESET,
        model: input.model
      };
      if (input.sessionId) {
        meta.set(input.sessionId, info);
        await handleFor(input.sessionId, { ...info, context: input.context });
        return { sessionId: input.sessionId };
      }
      const handle = await openSession({ ...info, cwdKey: input.key, context: input.context });
      const sessionId = handle.agent.session.id;
      meta.set(sessionId, info);
      handles.set(sessionId, Promise.resolve(handle));
      return { sessionId };
    },
    async send(sessionId, text4) {
      const info = meta.get(sessionId);
      if (!info) throw new Error("\u672A\u77E5\u4F1A\u8BDD\uFF1A\u5148\u53D1\u4E00\u6B21 chat/open \u518D\u53D1\u6D88\u606F");
      const handle = await handleFor(sessionId, info);
      handle.agent.followup({
        id: `msg-${randomUUID2()}`,
        role: "user",
        content: [{ type: "text", text: text4 }],
        source: { kind: "user" }
      });
    },
    liveStatus(sessionId) {
      const live = agents()?.get?.(sessionId);
      return { live: Boolean(live), running: Boolean(live && live.status === "running") };
    },
    async status(sessionId) {
      const live = agents()?.get?.(sessionId);
      const status = live && typeof live.status === "string" ? live.status : void 0;
      if (status) return { running: status === "running" };
      const query = sessionQuery();
      let events = [];
      if (query) {
        try {
          const snapshot = await query.readSession(sessionId);
          events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
        } catch {
          return { running: false };
        }
      }
      const scanned = chatMessagesFromEvents(events);
      return { running: scanned.running, ...scanned.error ? { error: scanned.error } : {} };
    },
    async read(sessionId) {
      const query = sessionQuery();
      let events = [];
      if (query) {
        try {
          const snapshot = await query.readSession(sessionId);
          events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
        } catch (error) {
          log(`[hams] \u8BFB\u4F1A\u8BDD ${sessionId} \u5931\u8D25\uFF1A${String(error)}`);
        }
      }
      const scanned = chatMessagesFromEvents(events);
      const live = agents()?.get?.(sessionId);
      const status = live && typeof live.status === "string" ? live.status : void 0;
      return { messages: scanned.messages, running: status ? status === "running" : scanned.running, ...scanned.error ? { error: scanned.error } : {} };
    },
    async stop(sessionId) {
      const pending2 = handles.get(sessionId);
      if (!pending2) return;
      const handle = await pending2;
      handle.agent.cancel({ kind: "user" }, { keepInbox: true });
    },
    async defaultModel() {
      const selection = defaultModelService()?.currentSelection?.();
      if (!selection || !selection.provider || !selection.model) return null;
      return { provider: String(selection.provider), model: String(selection.model) };
    },
    async presets() {
      const registry = presets();
      if (!registry) return [];
      try {
        const list = await registry.list();
        return Array.isArray(list) ? list.filter((row) => row && row.id && !row.id.startsWith(`${HAMS_BOT_PRESET}-`)) : [];
      } catch (error) {
        log(`[hams] \u8BFB preset \u76EE\u5F55\u5931\u8D25\uFF1A${String(error)}`);
        return [];
      }
    },
    async models() {
      const now = Date.now();
      if (modelsCache && now - modelsCache.at < 6e4) return modelsCache.rows;
      const rows = [];
      const seen = /* @__PURE__ */ new Set();
      const push = (provider, model, label) => {
        const key = `${provider}/${model}`;
        if (!provider || !model || seen.has(key)) return;
        seen.add(key);
        rows.push({ provider, model, label });
      };
      const llmService = llm();
      if (llmService) {
        try {
          for (const provider of llmService.listProviders()) {
            try {
              for (const model of await llmService.listModels(provider.id)) push(model.provider || provider.id, model.id, model.name);
            } catch {
            }
          }
        } catch (error) {
          log(`[hams] \u8BFB\u6A21\u578B\u76EE\u5F55\u5931\u8D25\uFF1A${String(error)}`);
        }
      }
      const fallback = defaultModelService()?.currentSelection();
      if (fallback && fallback.provider && fallback.model) push(fallback.provider, fallback.model, `${fallback.model}\uFF08\u5BBF\u4E3B\u9ED8\u8BA4\uFF09`);
      modelsCache = { at: now, rows };
      return rows;
    },
    async listSessions() {
      const query = sessionQuery();
      if (!query || typeof query.listSessions !== "function") return [];
      try {
        const rows = await query.listSessions();
        return (Array.isArray(rows) ? rows : []).map((row) => row?.header).filter((header) => Boolean(header && header.id)).map((header) => ({
          id: String(header.id),
          ...header.parentSession ? { parentSession: String(header.parentSession) } : {},
          ...header.origin === "subagent" ? { origin: "subagent" } : {},
          createdAt: Number(header.createdAt) || 0,
          ...header.cwd ? { cwd: String(header.cwd) } : {}
        }));
      } catch (error) {
        log(`[hams] \u5217\u4F1A\u8BDD\u5931\u8D25\uFF1A${String(error)}`);
        return [];
      }
    },
    async readSessionEvents(sessionId) {
      const query = sessionQuery();
      if (!query) return [];
      try {
        const snapshot = await query.readSession(sessionId);
        return snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
      } catch (error) {
        log(`[hams] \u8BFB\u4F1A\u8BDD ${sessionId} \u5931\u8D25\uFF1A${String(error)}`);
        return [];
      }
    },
    async dispose() {
      closed = true;
      for (const pending2 of [...handles.values(), ...openings.values()]) {
        try {
          const handle = await pending2;
          await handle.dispose();
        } catch {
        }
      }
      handles.clear();
      openings.clear();
    }
  };
  return runtime;
}

// src/host/session-adapter.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import path8 from "node:path";
import { mkdir as mkdir2 } from "node:fs/promises";
function buildRunFacts(db, runId, now = Date.now(), timeZone = "Asia/Shanghai") {
  const run = db.prepare("SELECT * FROM task_run WHERE id=?").get(runId);
  if (!run) throw new HamsError("STATE_INVALID", `\u8FD0\u884C\u4E0D\u5B58\u5728\uFF1A${runId}`);
  const item = db.prepare("SELECT * FROM work_item WHERE id=?").get(run.work_item_id);
  const template = item.template_version_id ? db.prepare("SELECT * FROM work_template_version WHERE id=?").get(item.template_version_id) : null;
  const version = db.prepare("SELECT prompt, agent_preset FROM member_version WHERE member_id=? AND version=?").get(run.member_id, run.member_version);
  const botPrompt = version && version.agent_preset && version.agent_preset !== HAMS_BOT_PRESET ? String(version.prompt || "").trim() : "";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const utc = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - (utc.getUTCDay() + 6) % 7);
  const week = utc.toISOString().slice(0, 10);
  const budgets = item.project_id ? db.prepare(`SELECT period_kind,period_start,metric,used,limit_value,
    MAX(0,limit_value-used) AS remaining FROM project_budget WHERE project_id=?
    AND ((period_kind='day' AND period_start=?) OR (period_kind='week' AND period_start=?)) ORDER BY period_kind,metric`).all(item.project_id, date, week) : [];
  return {
    stateAndEpoch: { workItemId: item.id, status: item.status, revision: item.revision, executionEpoch: item.execution_epoch, fence: run.fence, runtimeEpoch: run.runtime_epoch },
    evidenceAndHashes: { evidenceSetHash: item.evidence_set_hash, evidence: db.prepare("SELECT id,kind,ref,content_hash,observed_at,source FROM evidence WHERE work_item_id=? AND status='active' ORDER BY id").all(item.id) },
    taskAndCriteria: { runId, trigger: run.trigger, checkId: run.check_id, title: item.title, memberVersion: run.member_version, templateVersion: template ?? null, ...botPrompt ? { botPrompt } : {} },
    approvalsAndBlockers: { blockedReason: item.blocked_reason, approvals: db.prepare("SELECT id,status,reason_text,expires_at FROM approval WHERE subject_kind='work_item_close' AND subject_id=? AND status='pending' ORDER BY id").all(item.id) },
    budgetAndCapabilities: {
      budgets,
      permissions: db.prepare("SELECT capability,scope FROM member_permission WHERE member_id=? ORDER BY capability,scope").all(run.member_id),
      // 政策白名单为空 ≠ 没有工具：HAMS 工具是全局注册的，真实可用。把两者分开写，避免 bot 误判「tools 为空所以干不了」。
      toolPolicy: db.prepare("SELECT tool_name FROM member_tool_policy WHERE member_id=? AND enabled=1 ORDER BY tool_name").all(run.member_id),
      hamsTools: [...TOOL_NAMES],
      toolPolicyNote: "toolPolicy \u662F\u989D\u5916\u767D\u540D\u5355\uFF1BhamsTools \u4E00\u5B9A\u53EF\u7528\u3002\u5BBF\u4E3B\u53E6\u6709\u5168\u5C40\u5DE5\u5177\uFF08\u5982 working_directory\uFF09\u3002"
    }
  };
}
var HamsSessionAdapter = class {
  options;
  handles = /* @__PURE__ */ new Map();
  locks = /* @__PURE__ */ new Map();
  delivered = /* @__PURE__ */ new Set();
  closed = false;
  constructor(options) {
    this.options = options;
  }
  serial(key, fn) {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {
    }).then(() => {
      if (this.closed) throw new HamsError("HOST_CAPABILITY_MISSING", "\u4F1A\u8BDD\u9002\u914D\u5668\u5DF2\u505C\u6B62");
      return fn();
    });
    this.locks.set(key, next);
    void next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {
    });
    return next;
  }
  thread(workItemId) {
    return this.options.db.prepare("SELECT * FROM work_item_thread WHERE work_item_id=? AND status IN ('active','pending_rotate') ORDER BY generation DESC LIMIT 1").get(workItemId);
  }
  config(memberId, version) {
    const row = this.options.db.prepare(`SELECT v.*,m.status,m.kind,m.name FROM member_version v JOIN member m ON m.id=v.member_id WHERE v.member_id=? AND v.version=${version === void 0 ? "m.current_version" : "?"}`).get(...version === void 0 ? [memberId] : [memberId, version]);
    if (!row || row.kind !== "bot" || row.status !== "active") throw new HamsError("HOST_CAPABILITY_MISSING", "bot \u6CA1\u6709\u6709\u6548\u4E14\u5DF2\u53D1\u5E03\u7684\u5BBF\u4E3B preset");
    return { memberId, memberName: row.name, version: row.version, agentPreset: row.agent_preset || this.options.defaultPreset || "", model: row.model, prompt: row.prompt || "" };
  }
  needsRotation(thread) {
    return thread.status === "pending_rotate" || Boolean(this.options.db.prepare("SELECT 1 FROM member_version WHERE member_id=? AND version>? AND change_class='major'").get(thread.member_id, thread.member_version));
  }
  /** 宿主调用加超时：预设挂载/建会话卡住时不能让派发器永远停在 dispatching=true。 */
  async withTimeout(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new HamsError("HOST_CAPABILITY_MISSING", `${label}\u8D85\u65F6\uFF08${ms}ms\uFF09`, { nextStep: "\u68C0\u67E5\u5BBF\u4E3B agents \u670D\u52A1\u4E0E bot preset \u662F\u5426\u53EF\u7528\uFF1B\u5FC5\u8981\u65F6\u91CD\u542F DSH" })), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async open(config, existing, cwdKey) {
    if (existing && this.handles.has(existing)) return this.handles.get(existing);
    const id = existing ?? (this.options.sessionId ?? (() => `session-${randomUUID3()}`))();
    if (!id.trim() || this.handles.has(id)) throw new HamsError("STATE_INVALID", "\u5BBF\u4E3B\u4F1A\u8BDD id \u91CD\u590D\u6216\u4E3A\u7A7A");
    const pending2 = (async () => {
      const composition = await this.withTimeout(this.options.compose(config), 2e4, "\u7EC4\u5408 bot \u9884\u8BBE");
      const { agentPreset: composedPreset, ...rest } = composition;
      const presetId = composedPreset ?? config.agentPreset;
      const cwd = path8.resolve(this.options.dataDir, "bots", config.memberId, "work", String(cwdKey || "default").replace(/[^a-zA-Z0-9._-]+/g, "-") || "default");
      const base = path8.resolve(this.options.dataDir, "bots") + path8.sep;
      if (!cwd.startsWith(base)) throw new HamsError("POLICY_DENIED", "bot \u5DE5\u4F5C\u76EE\u5F55\u8D8A\u754C");
      await mkdir2(cwd, { recursive: true });
      const opening = existing ? this.options.agents.resume({ resumeSessionId: id, ...rest }) : this.options.agents.create({ sessionId: id, meta: { cwd, ...presetId ? { agentPreset: presetId } : {} }, ...rest });
      let handle;
      try {
        handle = await this.withTimeout(opening, 45e3, "\u5BBF\u4E3B\u521B\u5EFA/\u6062\u590D\u4F1A\u8BDD");
      } catch (error) {
        void opening.then((late) => late.dispose()).catch(() => {
        });
        throw error;
      }
      if (handle.agent.session.id !== id) {
        await handle.dispose();
        throw new HamsError("HOST_CAPABILITY_MISSING", "\u5BBF\u4E3B\u8FD4\u56DE\u7684\u4F1A\u8BDD\u8EAB\u4EFD\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
      }
      return handle;
    })();
    this.handles.set(id, pending2);
    try {
      return await pending2;
    } catch (error) {
      this.handles.delete(id);
      throw error;
    }
  }
  async release(sessionId) {
    const pending2 = this.handles.get(sessionId);
    if (!pending2) return;
    try {
      await (await pending2).dispose();
    } finally {
      this.handles.delete(sessionId);
    }
  }
  async cancel(sessionId) {
    const thread = this.options.db.prepare("SELECT * FROM work_item_thread WHERE session_id=?").get(sessionId);
    if (!thread) throw new HamsError("POLICY_DENIED", "\u4F1A\u8BDD\u672A\u7ED1\u5B9A HAMS \u5DE5\u4F5C\u9879");
    const handle = await this.open(this.config(thread.member_id, thread.member_version), sessionId, thread.work_item_id);
    await handle.agent.cancel({ kind: "user" }, { keepInbox: true });
    return { accepted: true };
  }
  async claim(ctx, input) {
    return this.serial(input.workItemId, async () => {
      const { service } = this.options;
      const item = service.getWorkItem(ctx, input.workItemId);
      if (item.status !== "ready") throw new HamsError("STATE_INVALID", "\u53EA\u6709 ready \u7684\u5DE5\u4F5C\u9879\u53EF\u4EE5\u8BA4\u9886");
      const principal = resolvePrincipal(this.options.db, ctx.principalId, this.now());
      if (ctx.channel === "system" && !principal.capabilities.has(CAPABILITY.workItemClaim)) {
        requireCapability(principal, CAPABILITY.workItemExecute);
      } else {
        requireCapability(principal, CAPABILITY.workItemClaim);
      }
      const thread = this.thread(item.id);
      const fresh = !thread || this.needsRotation(thread) || thread.member_id !== ctx.principalId;
      const handle = await this.open(this.config(ctx.principalId, fresh ? void 0 : thread.member_version), fresh ? void 0 : thread.session_id, item.id);
      try {
        const receipt = service.claim(ctx, { workItemId: item.id, sessionId: handle.agent.session.id });
        if (thread && thread.session_id !== handle.agent.session.id) await this.release(thread.session_id);
        return receipt;
      } catch (error) {
        if (fresh) await this.release(handle.agent.session.id);
        throw error;
      }
    });
  }
  async startRun(runId, text4 = "") {
    const run = this.options.db.prepare("SELECT * FROM task_run WHERE id=?").get(runId);
    if (!run) throw new HamsError("STATE_INVALID", `\u8FD0\u884C\u4E0D\u5B58\u5728\uFF1A${runId}`);
    return this.serial(run.work_item_id, () => this.start(runId, text4));
  }
  async start(runId, text4) {
    const { db, service } = this.options;
    const run = db.prepare("SELECT * FROM task_run WHERE id=?").get(runId);
    let thread = db.prepare("SELECT * FROM work_item_thread WHERE id=?").get(run.thread_id);
    if (this.delivered.has(runId)) return { sessionId: thread.session_id, runId, accepted: true };
    if (run.status !== "queued") throw new HamsError("STATE_INVALID", "\u53EA\u80FD\u6295\u9012 queued \u8FD0\u884C\uFF1B\u7ED3\u679C\u4E0D\u660E\u65F6\u4E0D\u81EA\u52A8\u91CD\u53D1");
    const rotate = this.needsRotation(thread);
    const oldId = thread.session_id;
    const handle = await this.open(this.config(run.member_id, rotate ? void 0 : thread.member_version), rotate ? void 0 : oldId, run.work_item_id);
    try {
      service.startRun({ principalId: run.member_id, channel: "system", correlationId: `host-start:${runId}` }, { runId, sessionId: handle.agent.session.id });
      thread = this.thread(run.work_item_id);
      const facts = buildRunFacts(db, runId, this.now(), this.options.timeZone);
      handle.agent.followup(this.options.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: `HAMS \u6570\u636E\u5E93\u4E8B\u5B9E\u5FEB\u7167\uFF1B\u672C\u8F6E\u4EE5\u6B64\u4E3A\u51C6\u3002
${JSON.stringify(facts)}
\u672C\u8F6E\u6307\u4EE4\uFF1A${text4 || "\u63A8\u8FDB\u672C\u8F6E\u4EFB\u52A1\uFF0C\u5E76\u901A\u8FC7 HAMS \u5DE5\u5177\u63D0\u4EA4\u7ED3\u679C\u6216\u963B\u585E\u3002"}` }] }));
      this.delivered.add(runId);
      if (rotate) await this.release(oldId);
      return { sessionId: thread.session_id, runId, accepted: true };
    } catch (error) {
      db.prepare("UPDATE task_run SET status='unknown',finished_at=?,error_kind='host_delivery_unknown' WHERE id=? AND status='running'").run(this.now(), runId);
      if (rotate && this.thread(run.work_item_id)?.session_id !== handle.agent.session.id) await this.release(handle.agent.session.id);
      throw error;
    }
  }
  async rotateThread(ctx, input) {
    return this.serial(input.workItemId, async () => {
      const item = this.options.service.getWorkItem(ctx, input.workItemId);
      this.authorize(ctx);
      if (!item.allowedActions.includes("rotateThread") || !item.assignee_id) throw new HamsError("STATE_INVALID", "\u5F53\u524D\u5DE5\u4F5C\u9879\u4E0D\u80FD\u6362\u65B0\u4F1A\u8BDD");
      const old = this.thread(item.id);
      const handle = await this.open(this.config(item.assignee_id), void 0, item.id);
      try {
        const result = this.options.service.rotateThread(ctx, { ...input, sessionId: handle.agent.session.id });
        if (old) await this.release(old.session_id);
        return result;
      } catch (error) {
        await this.release(handle.agent.session.id);
        throw error;
      }
    });
  }
  async instruct(ctx, input) {
    return this.serial(input.workItemId, async () => {
      this.authorize(ctx);
      if (!input.text?.trim()) throw new HamsError("STATE_INVALID", "\u8FFD\u52A0\u6307\u4EE4\u4E0D\u80FD\u4E3A\u7A7A");
      const item = this.options.service.getWorkItem(ctx, input.workItemId);
      if (["completed", "cancelled", "failed", "paused"].includes(item.status)) throw new HamsError("STATE_INVALID", "\u5F53\u524D\u5DE5\u4F5C\u9879\u4E0D\u63A5\u53D7\u8FFD\u52A0\u6307\u4EE4");
      const run = this.options.db.prepare("SELECT * FROM task_run WHERE work_item_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(item.id);
      if (!run) throw new HamsError("STATE_INVALID", "\u6CA1\u6709\u5F85\u6267\u884C\u6216\u6B63\u5728\u8FD0\u884C\u7684\u8F6E\u6B21\uFF1B\u8BF7\u5148\u91CD\u8BD5\u6216\u7B49\u5F85\u590D\u67E5");
      if (run.status === "queued") return this.start(run.id, input.text);
      const thread = this.thread(item.id);
      if (!thread || thread.status !== "active") throw new HamsError("STATE_INVALID", "\u5F53\u524D\u4F1A\u8BDD\u5DF2\u7B49\u5F85\u6362\u4EE3");
      const handle = await this.open(this.config(thread.member_id, thread.member_version), thread.session_id, item.id);
      handle.agent.followup(this.options.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: `HAMS \u6700\u65B0\u4E8B\u5B9E\uFF1A
${JSON.stringify(buildRunFacts(this.options.db, run.id, this.now(), this.options.timeZone))}
\u8FFD\u52A0\u6307\u4EE4\uFF1A${input.text}` }] }));
      return { sessionId: thread.session_id, runId: run.id, accepted: true };
    });
  }
  /**
   * 指派型任务：ready + 有 bot 负责人 + 没有排队/在跑的轮次 → 替它认领并投递这一轮。
   * 这是「bot 给 bot 分派任务」的落地点：协调 bot 只负责指派，真正的执行在被指派 bot 自己的会话里。
   */
  async dispatchAssignments(limit = 10) {
    const rows = this.options.db.prepare(
      `SELECT i.id, i.assignee_id FROM work_item i JOIN member m ON m.id = i.assignee_id
          WHERE i.status = 'ready' AND m.kind = 'bot' AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM task_run r WHERE r.work_item_id = i.id AND r.status IN ('queued','running'))
          ORDER BY i.updated_at LIMIT ?`
    ).all(limit);
    const report = { started: 0, errors: [] };
    for (const row of rows) {
      try {
        const receipt = await this.claim({ principalId: row.assignee_id, channel: "system", correlationId: `assign:${row.id}` }, { workItemId: row.id });
        const runId = receipt.detail && typeof receipt.detail === "object" ? receipt.detail.runId : void 0;
        if (runId) await this.startRun(runId);
        report.started++;
      } catch (error) {
        report.errors.push(`${row.id}: ${this.errorText(error)}`);
      }
    }
    return report;
  }
  errorText(error) {
    if (error && typeof error === "object" && "code" in error) return `${error.code}: ${error.message ?? ""}`;
    return String(error);
  }
  /** Call after each business tick. No recovery of unknown/running deliveries. */
  async dispatchQueued(limit = 20) {
    const rows = this.options.db.prepare("SELECT id FROM task_run WHERE status='queued' ORDER BY created_at LIMIT ?").all(limit);
    const report = { started: 0, errors: [] };
    for (const row of rows) try {
      await this.startRun(row.id);
      report.started++;
    } catch (error) {
      report.errors.push(`${row.id}: ${String(error)}`);
    }
    return report;
  }
  authorize(ctx) {
    const principal = resolvePrincipal(this.options.db, ctx.principalId, this.now());
    requireHuman(principal);
    requireCapability(principal, CAPABILITY.workItemManage);
    if (ctx.channel !== "ui") throw new HamsError("POLICY_DENIED", "\u4EBA\u5DE5\u4F1A\u8BDD\u64CD\u4F5C\u53EA\u63A5\u53D7 UI \u901A\u9053");
  }
  now() {
    return (this.options.now ?? Date.now)();
  }
  async dispose() {
    this.closed = true;
    await Promise.allSettled([...this.locks.values()]);
    for (const id of [...this.handles.keys()]) await this.release(id);
  }
};

// src/host/dsh-adapter.ts
import { createHash as createHash13 } from "node:crypto";

// src/host/intake-agent.ts
var DECISION_SCHEMA = `\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 markdown\u3001\u4E0D\u8981\u89E3\u91CA\u3002\u4E09\u79CD\u5F62\u6001\uFF1A
{"action":"create","title":"\u4E0D\u8D85\u8FC7 60 \u5B57\u7684\u5177\u4F53\u4EFB\u52A1\u6807\u9898","reason":"\u4E00\u53E5\u8BDD"}
{"action":"update","workItemId":"\u5FC5\u987B\u662F\u4E0B\u9762\u5217\u8868\u91CC\u7684 id","status":"paused|active|cancelled","reason":"\u4E00\u53E5\u8BDD"}
{"action":"none","reason":"\u4E00\u53E5\u8BDD"}`;
function buildPrompt(input) {
  const items = input.workItems.length ? input.workItems.slice(0, 20).map((item) => `- ${item.id}\uFF5C${item.status}\uFF5C${item.assignee ? `@${item.assignee}` : "\u672A\u6307\u6D3E"}\uFF5C${item.title}`).join("\n") : "\uFF08\u5F53\u524D\u6CA1\u6709\u672A\u7ED3\u5DE5\u4F5C\u9879\uFF09";
  const recent = input.recent ? `
\u6700\u8FD1\u7FA4\u804A\uFF08\u4F9B\u7406\u89E3\u201C\u8FD9\u4E2A/\u521A\u624D\u201D\u6307\u4EC0\u4E48\uFF09\uFF1A
${input.recent}
` : "";
  return `\u4F60\u662F HAMS \u7684\u4EFB\u52A1\u8BC6\u522B\u5668\u3002\u5224\u65AD\u4EBA\u7C7B\u8FD9\u53E5\u8BDD\u662F\u5728\u300C\u5F00\u4E00\u4EF6\u65B0\u6D3B\u300D\u8FD8\u662F\u5728\u300C\u6539\u67D0\u4E2A\u5DF2\u6709\u5DE5\u4F5C\u9879\u7684\u72B6\u6001\u300D\u3002

\u9879\u76EE\uFF1A${input.projectName}

\u5F53\u524D\u672A\u7ED3\u5DE5\u4F5C\u9879\uFF08id\uFF5C\u72B6\u6001\uFF5C\u8D1F\u8D23\u4EBA\uFF5C\u6807\u9898\uFF09\uFF1A
${items}
${recent}
\u4EBA\u7C7B\u65B0\u6D88\u606F\uFF1A
${input.message}

\u5224\u65AD\u53E3\u5F84\uFF1A
- \u53EA\u6709\u660E\u786E\u8981\u6C42\u505A\u4E00\u4EF6\u65B0\u7684\u3001\u53EF\u4EA4\u4ED8\u7684\u4E8B\uFF0C\u624D create\uFF1B\u5BD2\u6684\u3001\u611F\u8C22\u3001\u786E\u8BA4\u3001\u8FFD\u95EE\u8FDB\u5C55\u3001\u56DE\u7B54 bot \u7684\u95EE\u9898\u3001\u95F2\u804A\u90FD none\u3002
- \u53EA\u6709\u660E\u786E\u8981\u6C42\u6682\u505C/\u7EE7\u7EED/\u53D6\u6D88\u67D0\u4E2A\u5DF2\u6709\u5DE5\u4F5C\u9879\uFF0C\u624D update\uFF1B\u201C\u505A\u5B8C\u4E86/\u53EF\u4EE5\u5173\u5355\u4E86\u201D\u4E0D\u662F update\uFF08\u5173\u5355\u8981\u4EBA\u5BA1\u6279\uFF09\uFF0C\u7ED9 none\u3002
- \u4E0D\u8981\u81C6\u9020\u5DE5\u4F5C\u9879 id\uFF1B\u62FF\u4E0D\u51C6\u5C31 none\u3002
- create \u7684\u6807\u9898\u8981\u5177\u4F53\u3001\u80FD\u76F4\u63A5\u5F53\u4EFB\u52A1\u540D\uFF0C\u4E0D\u8981\u5E26\u201C\u5E2E\u6211/\u8BF7\u201D\u3002

${DECISION_SCHEMA}`;
}
function parseDecision(text4) {
  const trimmed = String(text4 || "").trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw;
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw;
  const action = value.action;
  const reason = typeof value.reason === "string" ? value.reason.slice(0, 200) : "";
  if (action === "create") {
    const title = typeof value.title === "string" ? value.title.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    if (title.length < 4) return null;
    return { action: "create", title, reason };
  }
  if (action === "update") {
    const workItemId = typeof value.workItemId === "string" ? value.workItemId.trim() : "";
    const status = value.status;
    if (!workItemId || status !== "paused" && status !== "active" && status !== "cancelled") return null;
    return { action: "update", workItemId, status, reason };
  }
  if (action === "none") return { action: "none", reason };
  return null;
}
function hasOff(info) {
  return Boolean(info?.reasoning?.efforts?.some((effort) => /^(off|none|no[-_]?think|minimal)$/i.test(effort.id)));
}
var modelChoiceCache = /* @__PURE__ */ new Map();
function chooseIntakeModel(llm, preferred) {
  if (preferred.reasoningEffort) return Promise.resolve(preferred);
  const key = `${preferred.provider}/${preferred.model}`;
  const cached = modelChoiceCache.get(key);
  if (cached) return cached;
  const task = (async () => {
    if (!llm.resolveModelInfo) return preferred;
    try {
      const info = await llm.resolveModelInfo(preferred.provider, preferred.model);
      if (hasOff(info)) return preferred;
    } catch {
      return preferred;
    }
    if (!llm.listModels) return preferred;
    let catalog = [];
    try {
      catalog = await llm.listModels(preferred.provider);
    } catch {
      return preferred;
    }
    for (const row of catalog.slice(0, 8)) {
      if (!row?.id || row.id === preferred.model) continue;
      try {
        const info = await llm.resolveModelInfo(preferred.provider, row.id);
        if (hasOff(info)) return { provider: preferred.provider, model: row.id };
      } catch {
      }
    }
    return preferred;
  })();
  modelChoiceCache.set(key, task);
  return task;
}
async function leastEffort(input) {
  if (input.model.reasoningEffort) return input.model.reasoningEffort;
  if (!input.llm.resolveModelInfo) return void 0;
  try {
    const info = await input.llm.resolveModelInfo(input.model.provider, input.model.model, input.signal);
    const efforts = info?.reasoning?.efforts ?? [];
    const off = efforts.find((effort) => /^(off|none|no[-_]?think|minimal)$/i.test(effort.id) || /off|none|不思考|无思考/i.test(effort.name));
    return (off ?? efforts[0])?.id;
  } catch {
    return void 0;
  }
}
async function classifyWorkRequest(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 1e4);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const chosen = await chooseIntakeModel(input.llm, input.model);
    const reasoningEffort = await leastEffort({ ...input, model: chosen, signal });
    const stream = input.llm.stream({
      provider: chosen.provider,
      model: chosen.model,
      messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(input) }] }],
      maxTokens: 300,
      ...reasoningEffort ? { reasoningEffort } : {},
      signal
    });
    let text4 = "";
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") text4 += chunk.text;
      if (text4.length > 2e3) break;
    }
    return parseDecision(text4);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// src/service/templates.ts
var STARTER_TEMPLATE = {
  id: "tpl-research-delivery",
  versionId: "tpl-research-delivery-v1",
  key: "research_delivery",
  name: "\u7814\u7A76\u4E0E\u4EA4\u4ED8\u63A8\u8FDB",
  domain: "\u7814\u7A76",
  category: "\u7814\u7A76\u63A8\u8FDB",
  /** 交付物一份 + 过程记录一份；720 小时是上限，不是要求每天都补。 */
  requiredEvidence: [
    { kind: "doc", min_count: 1, max_age_hours: 720 },
    { kind: "log", min_count: 1, max_age_hours: 720 }
  ],
  checkPolicy: { mode: "after_hours", hours: 72 },
  reviewPolicy: { approver: "owner", expires_hours: 72, auto_close: false }
};
function ensureStarterTemplate(db, publishedBy, now = Date.now()) {
  const seeded = db.prepare("SELECT value FROM hams_meta WHERE key = 'starter_template_at'").get();
  if (seeded) return null;
  const existing = db.prepare("SELECT id FROM work_template LIMIT 1").get();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!existing) {
      upsertTemplate(db, publishedBy, now, STARTER_TEMPLATE);
    }
    db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES ('starter_template_at', ?)").run(String(now));
    db.exec("COMMIT");
    return existing ? null : STARTER_TEMPLATE.versionId;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function upsertTemplate(db, publishedBy, now, definition) {
  const existing = db.prepare("SELECT * FROM work_template WHERE key = ?").get(definition.key);
  if (existing?.published_version_id) return existing.published_version_id;
  const templateId = existing?.id ?? definition.id;
  if (!existing) {
    db.prepare("INSERT INTO work_template (id, key, name, domain, category) VALUES (?, ?, ?, ?, ?)").run(
      templateId,
      definition.key,
      definition.name,
      definition.domain,
      definition.category
    );
  }
  const versionId = definition.versionId;
  db.prepare(
    `INSERT INTO work_template_version
       (id, template_id, version, required_evidence_json, validator_key, validator_params_json,
        check_policy_json, review_policy_json, misfire_policy, status, published_by, published_at)
     VALUES (?, ?, 1, ?, NULL, '{}', ?, ?, 'each', 'published', ?, ?)`
  ).run(
    versionId,
    templateId,
    JSON.stringify(definition.requiredEvidence),
    JSON.stringify(definition.checkPolicy),
    JSON.stringify(definition.reviewPolicy),
    publishedBy,
    now
  );
  db.prepare("UPDATE work_template SET published_version_id = ? WHERE id = ?").run(versionId, templateId);
  return versionId;
}
function removeTemplateIfUnused(db, templateIdOrKey) {
  const template = db.prepare("SELECT id, published_version_id FROM work_template WHERE id = ? OR key = ?").get(templateIdOrKey, templateIdOrKey);
  if (!template) return false;
  const versions = db.prepare("SELECT id FROM work_template_version WHERE template_id = ?").all(template.id);
  if (!versions.length) {
    db.prepare("DELETE FROM work_template WHERE id = ?").run(template.id);
    return true;
  }
  const placeholders = versions.map(() => "?").join(",");
  const versionIds = versions.map((version) => version.id);
  for (const table of ["work_item", "work_item_check", "schedule"]) {
    const referenced = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE template_version_id IN (${placeholders}) LIMIT 1`).get(...versionIds);
    if (referenced) return false;
  }
  db.prepare("UPDATE work_template SET published_version_id = NULL WHERE id = ?").run(template.id);
  db.prepare("DELETE FROM work_template_version WHERE template_id = ?").run(template.id);
  db.prepare("DELETE FROM work_template WHERE id = ?").run(template.id);
  return true;
}

// src/service/workspace-profile.ts
import { createHash as createHash12 } from "node:crypto";
import { readFileSync as readFileSync4, existsSync as existsSync6 } from "node:fs";
import path9 from "node:path";
var DAY = 864e5;
var DEFAULT_DOC_STATUS = "published";
function blankReport(file, status) {
  return {
    status,
    file,
    hash: null,
    workspaceRoot: null,
    created: {
      template: false,
      members: 0,
      projects: 0,
      workItems: 0,
      docs: 0,
      observations: 0,
      skills: 0,
      tables: 0,
      removedTemplates: 0
    },
    errors: [],
    warnings: []
  };
}
function defaultProfilePath(dataDir) {
  return path9.join(path9.resolve(dataDir), "workspace-profile.json");
}
function readProfile(file) {
  const raw = readFileSync4(file, "utf8");
  const hash = createHash12("sha256").update(raw).digest("hex");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`\u753B\u50CF\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("\u753B\u50CF\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
  const profile = parsed;
  if (profile.version !== 1) throw new Error(`\u753B\u50CF\u7248\u672C\u4E0D\u652F\u6301\uFF1A${String(profile.version)}\uFF0C\u5F53\u524D\u53EA\u652F\u6301 1`);
  if (profile.template && !profile.template.key) throw new Error("template.key \u4E0D\u80FD\u4E3A\u7A7A");
  return { profile, hash, raw };
}
function applyWorkspaceProfile(options) {
  const now = options.now ?? Date.now();
  const file = path9.resolve(options.file ?? defaultProfilePath(options.dataDir));
  if (!existsSync6(file)) return blankReport(file, "missing");
  let loaded;
  try {
    loaded = readProfile(file);
  } catch (error) {
    const report2 = blankReport(file, "failed");
    report2.errors.push(error.message);
    return report2;
  }
  const { profile, hash } = loaded;
  const workspaceRoot = path9.resolve(options.workspaceRoot ?? profile.workspaceRoot ?? process.cwd());
  const prior = options.db.prepare("SELECT value FROM hams_meta WHERE key = 'workspace_profile_sha256'").get();
  const report = blankReport(file, "applied");
  report.hash = hash;
  report.workspaceRoot = workspaceRoot;
  if (prior?.value === hash) {
    report.status = "unchanged";
    return report;
  }
  const knowledge = new KnowledgeService({
    db: options.db,
    now: () => now,
    idFactory: options.idFactory,
    dataDir: options.dataDir,
    skillDirs: options.skillDirs
  });
  try {
    transaction(options.db, () => {
      const templateKey = (profile.template ?? STARTER_TEMPLATE).key;
      const templateBefore = options.db.prepare("SELECT published_version_id FROM work_template WHERE key = ?").get(templateKey);
      const templateVersionId = upsertTemplate(
        options.db,
        options.operatorId,
        now,
        profile.template ?? STARTER_TEMPLATE
      );
      report.created.template = !templateBefore?.published_version_id;
      const memberIds = /* @__PURE__ */ new Map();
      for (const member of profile.members ?? []) {
        const existing = options.db.prepare("SELECT id FROM member WHERE name = ?").get(member.name);
        if (existing) {
          memberIds.set(member.key, existing.id);
          continue;
        }
        try {
          const input = {
            kind: member.kind,
            name: member.name,
            role: member.role,
            domain: member.domain,
            responsibility: member.responsibility,
            positionId: member.positionId,
            ownerHumanId: member.kind === "bot" ? options.operatorId : void 0,
            capabilities: member.capabilities
          };
          const created = insertMember(options.db, options.idFactory, now, options.operatorId, input);
          memberIds.set(member.key, created.id);
          report.created.members += 1;
        } catch (error) {
          report.errors.push(`\u6210\u5458\u300C${member.name}\u300D\uFF1A${error.message}`);
        }
      }
      const projectIds = /* @__PURE__ */ new Map();
      for (const project of profile.projects ?? []) {
        const existing = options.db.prepare("SELECT id FROM project WHERE name = ? AND deleted_at IS NULL").get(project.name);
        if (existing) {
          projectIds.set(project.key, existing.id);
          continue;
        }
        try {
          const metrics = (project.metrics ?? []).map((metric) => ({
            name: metric.name,
            direction: metric.direction,
            targetValue: metric.targetValue,
            targetMax: metric.targetMax,
            unit: metric.unit,
            windowKind: metric.windowKind,
            definitionText: metric.definitionText,
            sourceKind: metric.sourceKind
          }));
          const created = insertProject(options.db, options.idFactory, now, options.operatorId, {
            name: project.name,
            type: project.type,
            goalText: project.goalText,
            coordinatorId: project.coordinatorKey ? memberIds.get(project.coordinatorKey) ?? null : null,
            metrics,
            publish: project.status !== "draft"
          });
          projectIds.set(project.key, created.id);
          report.created.projects += 1;
          for (const metric of project.metrics ?? []) {
            const metricRow = options.db.prepare("SELECT id FROM project_metric WHERE project_id = ? AND name = ?").get(created.id, metric.name);
            if (!metricRow) continue;
            for (const observation of metric.observations ?? []) {
              const exists = options.db.prepare("SELECT 1 AS ok FROM metric_observation WHERE metric_id = ? AND source_ref = ? LIMIT 1").get(metricRow.id, observation.sourceRef ?? "");
              if (exists) continue;
              options.db.prepare(
                `INSERT INTO metric_observation
                     (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                options.idFactory(),
                metricRow.id,
                now,
                now,
                now,
                observation.value,
                observation.sourceRef ?? null,
                now
              );
              report.created.observations += 1;
            }
          }
        } catch (error) {
          report.errors.push(`\u9879\u76EE\u300C${project.name}\u300D\uFF1A${error.message}`);
        }
      }
      for (const item of profile.workItems ?? []) {
        const dedupeKey = `profile:${item.key}`;
        const existing = options.db.prepare("SELECT id FROM work_item WHERE dedupe_key = ?").get(dedupeKey);
        if (existing) continue;
        try {
          const projectId = item.projectKey ? projectIds.get(item.projectKey) ?? null : null;
          const inserted = insertWorkItem(
            { db: options.db, ids: options.idFactory, now: () => now, timeZone: "Asia/Shanghai" },
            {
              domain: item.domain,
              category: item.category,
              title: item.title,
              ownerHumanId: options.operatorId,
              projectId,
              templateVersionId,
              dedupeKey,
              priority: item.priority,
              dueAt: now + (item.dueInDays ?? 7) * DAY,
              createdBy: options.operatorId,
              actorKind: "human"
            }
          );
          if (item.source) {
            writeEvent(options.db, options.idFactory(), {
              workItemId: inserted.id,
              kind: "profile_source",
              actorId: options.operatorId,
              actorKind: "human",
              payload: { source: item.source },
              revision: inserted.revision,
              executionEpoch: inserted.execution_epoch,
              at: now
            });
          }
          report.created.workItems += 1;
        } catch (error) {
          report.errors.push(`\u5DE5\u4F5C\u9879\u300C${item.title}\u300D\uFF1A${error.message}`);
        }
      }
      for (const doc of profile.docs ?? []) {
        const absolute = path9.isAbsolute(doc.path) ? doc.path : path9.join(workspaceRoot, doc.path);
        if (!existsSync6(absolute)) {
          report.errors.push(`\u6587\u6863\u4E0D\u5B58\u5728\uFF1A${absolute}`);
          continue;
        }
        try {
          const outcome = knowledge.importFile(options.operatorId, absolute, {
            title: doc.title,
            status: DEFAULT_DOC_STATUS
          });
          if (outcome !== "skipped") report.created.docs += 1;
        } catch (error) {
          report.errors.push(`\u6587\u6863\u300C${doc.title ?? doc.path}\u300D\uFF1A${error.message}`);
        }
      }
      if (profile.overview?.title && profile.overview?.body) {
        const exists = options.db.prepare("SELECT 1 AS ok FROM kb_doc WHERE title = ? AND source_kind = 'hams' LIMIT 1").get(profile.overview.title);
        if (!exists) {
          try {
            knowledge.createDoc(options.operatorId, {
              title: profile.overview.title,
              body: profile.overview.body,
              status: "draft"
            });
            report.created.docs += 1;
          } catch (error) {
            report.errors.push(`\u603B\u89C8\u6587\u6863\uFF1A${error.message}`);
          }
        }
      }
      try {
        const sync = knowledge.sync(options.operatorId);
        report.created.skills = sync.skills.created + sync.skills.updated;
        report.created.tables = sync.tables.created + sync.tables.updated;
        report.warnings.push(...sync.skills.errors.slice(0, 5));
        report.warnings.push(...sync.tables.errors.slice(0, 5));
      } catch (error) {
        report.warnings.push(`\u77E5\u8BC6\u540C\u6B65\uFF1A${error.message}`);
      }
      for (const legacy of profile.cleanupTemplates ?? []) {
        if (removeTemplateIfUnused(options.db, legacy)) report.created.removedTemplates += 1;
      }
      writeAudit(options.db, options.idFactory(), {
        actorId: "system",
        actorKind: "system",
        channel: "system",
        action: "workspace/profileApplied",
        subjectKind: "workspace_profile",
        subjectId: hash,
        after: { file, workspaceRoot, created: report.created, errors: report.errors.length },
        correlationId: `profile-${hash.slice(0, 12)}`,
        at: now
      });
      if (!report.errors.length) {
        options.db.prepare(
          `INSERT INTO hams_meta (key, value) VALUES ('workspace_profile_sha256', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(hash);
        options.db.prepare(
          `INSERT INTO hams_meta (key, value) VALUES ('workspace_profile_applied_at', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(String(now));
      }
    });
  } catch (error) {
    report.status = "failed";
    report.errors.push(error.message);
  }
  return report;
}

// src/host/dsh-adapter.ts
var DEFAULT_ORIGINS = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"];
function toHeaderRecord(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}
async function readRequestBody(request, maxBytes = 256 * 1024) {
  if (typeof request.body === "string") return request.body;
  const chunks = [];
  let size = 0;
  const push = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927");
    chunks.push(buffer);
  };
  if (request[Symbol.asyncIterator]) {
    for await (const chunk of request) push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof request.on === "function") {
    await new Promise((resolve, reject) => {
      request.on("data", (chunk) => {
        try {
          push(chunk);
        } catch (error) {
          reject(error);
        }
      });
      request.on("end", () => resolve());
      request.on("error", (error) => reject(error));
    });
    return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}
function writeResponse(response, result) {
  if (typeof response.writeHead === "function") {
    response.writeHead(result.status, result.headers);
  } else if (typeof response.setHeader === "function") {
    response.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
  } else {
    response.statusCode = result.status;
  }
  response.end?.(result.body);
}
function isAllowedOrigin(origin, allowed = DEFAULT_ORIGINS) {
  return allowed.some((prefix) => origin === prefix.replace(/:$/, "") || origin.startsWith(prefix));
}
var UNAUTHENTICATED_MESSAGE = "\u6D4F\u89C8\u5668\u4F1A\u8BDD\u672A\u901A\u8FC7\u8BA4\u8BC1\uFF08\u6CA1\u6709\u5BBF\u4E3B\u4F1A\u8BDD cookie\uFF0C\u6216\u5DF2\u8FC7\u671F\uFF09";
var UNAUTHENTICATED_NEXT_STEP = "\u7528 dsh \u6253\u5370\u7684\u5E26 ?token= \u7684\u5730\u5740\u91CD\u65B0\u6253\u5F00\u8FD9\u4E00\u9875\uFF08\u6216\u5237\u65B0\uFF09\uFF0C\u518D\u64CD\u4F5C\u9762\u677F";
var UNTRUSTED_MESSAGE = "\u8BF7\u6C42\u6765\u6E90\u4E0D\u88AB\u5BBF\u4E3B\u4FE1\u4EFB\uFF08Host/Origin \u6821\u9A8C\u5931\u8D25\uFF09";
var UNTRUSTED_NEXT_STEP = "\u53EA\u4ECE\u672C\u673A 127.0.0.1/localhost \u6253\u5F00\u9762\u677F\uFF1B\u4E0D\u8981\u7528\u5916\u90E8\u9875\u9762\u8C03\u7528";
function unauthenticated() {
  return { ok: false, reason: "UNAUTHORIZED", message: UNAUTHENTICATED_MESSAGE, nextStep: UNAUTHENTICATED_NEXT_STEP };
}
function untrusted() {
  return { ok: false, reason: "FORBIDDEN", message: UNTRUSTED_MESSAGE, nextStep: UNTRUSTED_NEXT_STEP };
}
function checkHostSession(connection, headers, mode = "auto") {
  if (mode === "off") return { ok: true };
  if (!connection) {
    if (mode === "require") {
      return {
        ok: false,
        reason: "FORBIDDEN",
        message: "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B connection \u670D\u52A1\uFF0C\u65E0\u6CD5\u6821\u9A8C\u6D4F\u89C8\u5668\u4F1A\u8BDD",
        nextStep: "\u628A\u63D2\u4EF6\u88C5\u8FDB\u5E26 Web \u8F7D\u4F53\u7684\u5BBF\u4E3B\uFF0C\u6216\u628A\u914D\u7F6E hostSession \u8BBE\u4E3A auto\uFF08\u53EA\u9A8C Origin\uFF09"
      };
    }
    return { ok: true };
  }
  const request = { headers };
  try {
    if (typeof connection.admit === "function") {
      const admission = connection.admit(request);
      if ("rejection" in admission) {
        return admission.rejection === 401 ? unauthenticated() : untrusted();
      }
      const kind = admission.peer?.principal?.kind;
      if (kind !== void 0 && kind !== "owner") {
        return {
          ok: false,
          reason: "FORBIDDEN",
          message: `\u4E3B\u4F53\u7C7B\u578B ${kind} \u4E0D\u80FD\u8C03\u7528 HAMS \u754C\u9762\u63A5\u53E3`,
          nextStep: "bot \u53EA\u80FD\u8D70\u5DE5\u5177\u901A\u9053\uFF1B\u754C\u9762\u63A5\u53E3\u53EA\u670D\u52A1\u5DF2\u8BA4\u8BC1\u7684\u672C\u673A\u64CD\u4F5C\u8005"
        };
      }
      return { ok: true };
    }
    if (typeof connection.requestRejection === "function") {
      const rejection = connection.requestRejection(request);
      if (rejection === 401) return unauthenticated();
      if (rejection === 403) return untrusted();
      return { ok: true };
    }
    if (mode === "require") {
      return {
        ok: false,
        reason: "FORBIDDEN",
        message: "\u5BBF\u4E3B connection \u670D\u52A1\u6CA1\u6709\u53EF\u7528\u7684\u8BA4\u8BC1\u5165\u53E3",
        nextStep: "\u786E\u8BA4\u5BBF\u4E3B\u7248\u672C\u63D0\u4F9B admit/requestRejection\uFF0C\u6216\u628A hostSession \u8BBE\u4E3A auto"
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "FORBIDDEN",
      message: `\u5BBF\u4E3B\u4F1A\u8BDD\u6821\u9A8C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`,
      nextStep: "\u770B\u5BBF\u4E3B\u65E5\u5FD7\u786E\u8BA4 connection \u670D\u52A1\u72B6\u6001\u540E\u91CD\u8BD5"
    };
  }
}
function createLocalAuthenticator(db, config, resolveConnection) {
  const allowed = config.allowedOrigins ?? DEFAULT_ORIGINS;
  const mode = config.hostSession ?? "auto";
  return (request) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin, allowed)) {
      return { ok: false, reason: "FORBIDDEN", message: `\u975E\u540C\u6E90\u8BF7\u6C42\uFF1A${origin}`, nextStep: UNTRUSTED_NEXT_STEP };
    }
    const verdict = checkHostSession(resolveConnection?.(), request.headers, mode);
    if (!verdict.ok) return verdict;
    let principalId = config.localPrincipalId ?? "";
    if (!principalId) {
      const row = db.prepare("SELECT member_id FROM hams_user WHERE auth_source = 'local_host' AND status = 'active' LIMIT 1").get();
      principalId = row?.member_id ?? "";
    }
    if (!principalId) {
      return {
        ok: false,
        reason: "FORBIDDEN",
        message: "\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u672C\u673A\u64CD\u4F5C\u8005\uFF1A\u8BF7\u5148\u5EFA\u7ACB hams_user(auth_source=local_host) \u6216\u914D\u7F6E localPrincipalId",
        nextStep: "\u91CD\u542F\u63D2\u4EF6\u4F1A\u9996\u6B21\u81EA\u52A8\u521B\u5EFA\u672C\u673A\u64CD\u4F5C\u8005\uFF1B\u82E5\u4ECD\u5931\u8D25\uFF0C\u68C0\u67E5 hams_user \u8868"
      };
    }
    return { ok: true, principalId, authSubject: origin ?? "local_host" };
  };
}
function toHostParameters(schema) {
  const properties = schema.properties ?? {};
  return {
    type: "object",
    properties,
    ...Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {},
    additionalProperties: schema.additionalProperties === void 0 ? false : schema.additionalProperties
  };
}
function hostToolOutput(renderKey = "render") {
  return {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        [renderKey]: { type: "string" }
      },
      required: ["ok", renderKey]
    },
    render: (_args, value) => [
      { type: "text", text: String(value?.[renderKey] ?? JSON.stringify(value)) }
    ]
  };
}
function renderToolResult(name2, result) {
  if (result.ok) {
    return {
      ok: true,
      render: `${name2} \u6210\u529F\uFF1A${JSON.stringify(result.data ?? {}, null, 2).slice(0, 4e3)}`
    };
  }
  return {
    ok: false,
    code: result.error?.code,
    render: `${name2} \u5931\u8D25\uFF08${result.error?.code}\uFF09\uFF1A${result.error?.message}
\u4E0B\u4E00\u6B65\uFF1A${result.error?.nextStep}`
  };
}
function toHostTools(definitions, options = {}) {
  const define = options.defineTool ?? ((definition) => definition);
  return definitions.map((definition) => {
    const parameters = toHostParameters(definition.parameters);
    const tool = define({
      name: definition.name,
      description: definition.description,
      parameters,
      output: hostToolOutput(),
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.sessionId ?? "";
        const result = await definition.execute(args, { sessionId });
        return renderToolResult(definition.name, result);
      }
    });
    return tool;
  });
}
function ensureLocalOperator(db, now = Date.now()) {
  const existing = db.prepare("SELECT member_id FROM hams_user WHERE auth_source = 'local_host' AND status = 'active' LIMIT 1").get();
  if (existing) return existing.member_id;
  const memberId = "h-owner";
  const positionId = "pos-owner";
  db.exec("BEGIN IMMEDIATE");
  try {
    const member = db.prepare("SELECT id FROM member WHERE id = ?").get(memberId);
    if (!member) {
      db.prepare(
        `INSERT INTO member (id, kind, name, role, current_version, created_at, updated_at)
         VALUES (?, 'human', '\u672C\u673A\u64CD\u4F5C\u8005', 'coordinator', 0, ?, ?)`
      ).run(memberId, now, now);
    }
    const position = db.prepare("SELECT id FROM position WHERE id = ?").get(positionId);
    if (!position) {
      db.prepare("INSERT INTO position (id, name, domain, description) VALUES (?, '\u672C\u673A\u8D1F\u8D23\u4EBA', NULL, 'P1 \u81EA\u52A8\u521B\u5EFA')").run(positionId);
    }
    const capability = db.prepare(
      "INSERT OR IGNORE INTO position_permission (position_id, capability, scope) VALUES (?, ?, ?)"
    );
    for (const name2 of [
      "work_item.create",
      "work_item.accept",
      "work_item.manage",
      "work_item.request_closure",
      "evidence.append",
      "check.evaluate",
      "proposal.decide",
      "approval.decide"
    ]) {
      capability.run(positionId, name2, "global");
    }
    const assigned = db.prepare("SELECT 1 FROM member_position WHERE member_id = ? AND position_id = ?").get(memberId, positionId);
    if (!assigned) {
      db.prepare(
        `INSERT INTO member_position (member_id, position_id, starts_at, ends_at, assigned_by)
         VALUES (?, ?, 0, NULL, 'system')`
      ).run(memberId, positionId);
    }
    db.prepare(
      `INSERT INTO hams_user (id, member_id, login, display_name, auth_source, external_id, is_admin, status, last_login_at)
       VALUES ('user-local', ?, 'local', '\u672C\u673A\u64CD\u4F5C\u8005', 'local_host', 'local', 1, 'active', ?)`
    ).run(memberId, now);
    db.exec("COMMIT");
    return memberId;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
var OPERATOR_CAPABILITIES = [
  "work_item.create",
  "work_item.accept",
  "work_item.manage",
  "work_item.request_closure",
  "evidence.append",
  "check.evaluate",
  "proposal.decide",
  "approval.decide",
  "project.create",
  "project.manage",
  "project.archive",
  "target.publish",
  "review.confirm",
  "metric.record",
  "member.manage",
  "knowledge.write",
  "knowledge.sync"
];
function ensureOperatorCapabilities(db, memberId) {
  const position = db.prepare("SELECT id FROM position WHERE id = 'pos-owner'").get();
  if (!position) return 0;
  const assigned = db.prepare("SELECT 1 AS ok FROM member_position WHERE member_id = ? AND position_id = ? AND ends_at IS NULL").get(memberId, position.id);
  if (!assigned) return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO position_permission (position_id, capability, scope) VALUES (?, ?, ?)"
  );
  let added = 0;
  for (const capability of OPERATOR_CAPABILITIES) added += Number(insert.run(position.id, capability, "global").changes ?? 0);
  return added;
}
function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : "";
  return configured ? path10.resolve(configured) : path10.join(homedir3(), ".dsh");
}
function isLockError(error) {
  const code = error?.code;
  return code === "LOCK_HELD" || code === "LOCK_HELD_SELF";
}
function registerHams(ctx, config = {}) {
  const startedAt = Date.now();
  const dataDir = resolveDataDir(config.dataDir);
  let runtime = null;
  let reader = null;
  let mode;
  try {
    runtime = bootstrapStore({ dataDir, backupKeep: config.backupKeep });
    mode = "writer";
  } catch (error) {
    if (!isLockError(error)) throw error;
    reader = openReadOnlyStore(dataDir);
    mode = "reader";
  }
  const db = runtime?.db ?? reader.db;
  const dshHome = resolveDshHome();
  const knowledgeSkillDirs = config.knowledgeSkillDirs && config.knowledgeSkillDirs.length ? [...config.knowledgeSkillDirs] : [path10.join(dshHome, "skills")];
  let starterTemplateVersionId = null;
  let operatorCapabilitiesAdded = 0;
  let workspaceProfile = null;
  let defaultBots = null;
  if (mode === "writer") {
    const operatorId = ensureLocalOperator(db, startedAt);
    operatorCapabilitiesAdded = ensureOperatorCapabilities(db, operatorId);
    starterTemplateVersionId = ensureStarterTemplate(db, operatorId, startedAt);
    try {
      defaultBots = ensureDefaultBots(db, createIdFactory(() => Date.now()), startedAt, operatorId);
    } catch (error) {
      ctx.logger?.warn?.(`[hams] \u9ED8\u8BA4 bot \u8865\u9F50\u5931\u8D25\uFF1A${String(error)}`);
    }
    workspaceProfile = applyWorkspaceProfile({
      db,
      dataDir,
      operatorId,
      now: startedAt,
      idFactory: createIdFactory(() => Date.now()),
      file: config.workspaceProfileFile?.trim() || defaultProfilePath(dataDir),
      workspaceRoot: config.workspaceRoot?.trim() || void 0,
      skillDirs: knowledgeSkillDirs
    });
  }
  if (mode === "writer") {
    try {
      ensureAllDefaultPlans(db, createIdFactory(() => Date.now()), Date.now());
    } catch (error) {
      ctx.logger?.warn?.(`[hams] \u8865\u9ED8\u8BA4\u9636\u6BB5\u5931\u8D25\uFF1A${String(error)}`);
    }
  }
  const service = new HamsService({
    db,
    runtimeEpoch: runtime?.report.runtimeEpoch ?? readRuntimeEpoch(db),
    knowledge: { dataDir, skillDirs: knowledgeSkillDirs }
  });
  const chatRuntime = mode === "writer" ? createHostChatRuntime({ ctx, dataDir, log: (line) => ctx.logger?.warn?.(line) }) : null;
  const intake = chatRuntime && config.autoIntake !== false ? {
    async registerFromMessage(input) {
      const project = db.prepare("SELECT id, name, owner_human_id, status FROM project WHERE id = ? AND deleted_at IS NULL").get(input.projectId);
      if (!project || project.status !== "active") return null;
      const sender = db.prepare("SELECT kind, status FROM member WHERE id = ?").get(input.senderId);
      if (!sender || sender.kind !== "human") return null;
      const llm = hostService("llm");
      if (!llm || typeof llm.stream !== "function") return null;
      const selection = hostService(
        "agentDefaultModel"
      )?.currentSelection?.();
      let model = null;
      if (config.intakeModel?.trim()) {
        const parsed = await parseModelChoice(config.intakeModel, llm, selection?.provider);
        if (parsed?.model) model = { provider: parsed.provider || selection?.provider || "", model: parsed.model, reasoningEffort: config.intakeReasoningEffort };
      } else if (selection?.provider && selection.model) {
        model = { provider: selection.provider, model: selection.model, reasoningEffort: config.intakeReasoningEffort };
      }
      if (!model?.provider) return null;
      const items = db.prepare(
        `SELECT w.id, w.title, w.status, m.name AS assignee
                 FROM work_item w LEFT JOIN member m ON m.id = w.assignee_id
                WHERE w.project_id = ? AND w.status NOT IN ('completed','cancelled')
                ORDER BY w.updated_at DESC LIMIT 20`
      ).all(project.id);
      const decision = await classifyWorkRequest({
        llm,
        model,
        projectName: project.name,
        workItems: items,
        recent: input.recent,
        message: input.text
      });
      if (!decision || decision.action === "none") return null;
      const base = {
        principalId: input.senderId,
        channel: "ui",
        correlationId: `intake:${input.messageId}`,
        idempotencyKey: `intake:${input.messageId}`
      };
      if (decision.action === "create") {
        const dedupeKey = `intake:${project.id}:${createHash13("sha256").update(decision.title.replace(/\s+/g, "")).digest("hex").slice(0, 16)}`;
        try {
          const receipt = service.createWorkItem(base, {
            projectId: project.id,
            domain: "\u901A\u7528",
            category: "\u7FA4\u804A\u8BF7\u6C42",
            title: decision.title,
            ownerHumanId: input.senderId,
            dedupeKey
          });
          const workItemId = String(receipt.objectId || "");
          if (!workItemId) return null;
          if (input.mentionedMemberId && receipt.status === "applied") {
            try {
              service.assignWorkItem(
                { ...base, correlationId: `intake-assign:${input.messageId}` },
                { workItemId, memberId: input.mentionedMemberId }
              );
            } catch {
            }
          }
          return { kind: "create", workItemId, title: decision.title, created: receipt.status === "applied" };
        } catch (error) {
          ctx.logger?.warn?.(`[hams] \u8BC6\u522B\u5EFA\u5355\u5931\u8D25\uFF1A${String(error)}`);
          return null;
        }
      }
      const item = db.prepare("SELECT id, title, status FROM work_item WHERE id = ? AND project_id = ?").get(decision.workItemId, project.id);
      if (!item || item.status === "completed" || item.status === "cancelled") return null;
      if (item.status === decision.status) {
        return { kind: "update", workItemId: item.id, title: item.title, status: decision.status, changed: false };
      }
      try {
        const reason = `\u7FA4\u804A\u6307\u4EE4\uFF1A${input.text.slice(0, 200)}`;
        if (decision.status === "paused") service.pause(base, { workItemId: item.id, reason });
        else if (decision.status === "active") service.resume(base, { workItemId: item.id, reason });
        else service.cancel(base, { workItemId: item.id, reason });
      } catch (error) {
        ctx.logger?.warn?.(`[hams] \u8BC6\u522B\u6539\u72B6\u6001\u5931\u8D25\uFF1A${String(error)}`);
        return null;
      }
      return { kind: "update", workItemId: item.id, title: item.title, status: decision.status, changed: true };
    }
  } : void 0;
  const chat = chatRuntime ? new ChatService({ db, runtime: chatRuntime, intake }) : null;
  const disposers = [];
  if (chat && typeof ctx.on === "function") {
    const labels = /* @__PURE__ */ new Map();
    const textOf = (content) => {
      if (!Array.isArray(content)) return "";
      return content.filter((block2) => block2 && typeof block2 === "object" && block2.type === "text").map((block2) => String(block2.text ?? "")).join("\n").trim().slice(0, 8192);
    };
    const register = (childSessionId, parentSessionId, label, prompt) => {
      try {
        chat.registerSubagent({ childSessionId, parentSessionId, label, prompt });
      } catch (error) {
        ctx.logger?.warn?.(`[hams] \u767B\u8BB0\u5B50\u4EE3\u7406\u5931\u8D25\uFF1A${String(error)}`);
      }
    };
    const off = ctx.on("session/event", (session, event) => {
      const header = session?.header ?? session?.meta;
      if (!header || header.origin !== "subagent" || !header.parentSession || !header.id) return;
      if (event?.type === "subagent/descriptor") {
        if (labels.size > 200) labels.clear();
        labels.set(String(header.id), typeof event.data?.label === "string" ? event.data.label : "");
        return;
      }
      if (event?.type !== "user/message") return;
      if (event.data?.source?.kind !== "user") return;
      if (Number(event.time || 0) < Number(header.createdAt || 0)) return;
      const prompt = textOf(event.data.content);
      if (!prompt) return;
      const childSessionId = String(header.id);
      const parentSessionId = String(header.parentSession);
      const known = labels.get(childSessionId) || "";
      if (known) {
        register(childSessionId, parentSessionId, known, prompt);
        labels.delete(childSessionId);
        return;
      }
      void (async () => {
        let label = "";
        try {
          const query = ctx.get?.("sessionQuery");
          const events = query?.readSession ? (await query.readSession(childSessionId)).events ?? [] : [];
          const descriptor = events.find((item) => item && typeof item === "object" && item.type === "subagent/descriptor");
          label = typeof descriptor?.data?.label === "string" ? descriptor.data.label : "";
        } catch {
          label = "";
        }
        register(childSessionId, parentSessionId, label, prompt);
      })();
    });
    if (typeof off === "function") disposers.push(off);
  }
  let sessionAdapter = null;
  if (mode === "writer" && config.botRuntime !== false) {
    const agentsProxy = {
      async create(options) {
        const agents = hostService("agents");
        if (!agents) throw new Error("\u5BBF\u4E3B\u6CA1\u6709 agents \u670D\u52A1");
        return await agents.create(options);
      },
      async resume(options) {
        const agents = hostService("agents");
        if (!agents) throw new Error("\u5BBF\u4E3B\u6CA1\u6709 agents \u670D\u52A1");
        return await agents.resume(options);
      }
    };
    sessionAdapter = new HamsSessionAdapter({
      db,
      service,
      dataDir,
      defaultPreset: HAMS_BOT_PRESET,
      agents: agentsProxy,
      createUserMessage: (input) => ({ id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, role: "user", ...input }),
      compose: async (bot) => {
        const preset = await resolveBotPreset(
          ctx,
          { memberId: bot.memberId, memberName: bot.memberName, version: bot.version, prompt: bot.prompt, preset: bot.agentPreset },
          (line) => ctx.logger?.warn?.(line)
        );
        const selection = hostService("agentDefaultModel")?.currentSelection?.();
        const model = await resolveAgentOptions(bot.model, hostService("llm"), selection);
        if (!model) {
          throw new HamsError(
            "HOST_CAPABILITY_MISSING",
            `bot ${bot.memberId} \u6CA1\u6709\u914D\u7F6E\u6A21\u578B\uFF0C\u5BBF\u4E3B\u4E5F\u6CA1\u6709\u9ED8\u8BA4\u6A21\u578B`,
            { nextStep: "\u5728\u6210\u5458\u914D\u7F6E\u91CC\u7ED9\u8FD9\u4E2A bot \u9009\u4E00\u4E2A\u6A21\u578B\uFF0C\u6216\u5728\u5BBF\u4E3B\u8BBE\u7F6E\u91CC\u9009\u4E00\u4E2A\u9ED8\u8BA4\u6A21\u578B" }
          );
        }
        const registry = hostService("agentPresets");
        const setup = registry && preset ? async (agentCtx) => {
          await registry.mount(agentCtx, preset);
        } : void 0;
        return { agentOptions: model ? { ...model } : {}, ...setup ? { setup } : {}, agentPreset: preset };
      }
    });
  }
  const resolveConnection = () => {
    if (config.connection) return config.connection;
    if (typeof ctx.get !== "function") return void 0;
    try {
      const found = ctx.get("connection");
      return found && typeof found === "object" ? found : void 0;
    } catch {
      return void 0;
    }
  };
  const sessionMode = config.hostSession ?? "auto";
  const sessionState = sessionMode === "off" ? "off" : resolveConnection() ? "host" : "origin-only";
  let ticker = null;
  if (mode === "writer" && config.tickEnabled !== false) {
    const recovered = recover({ db, runtimeEpoch: runtime.report.runtimeEpoch, dataDir });
    if (recovered.cancelledQueuedRuns || recovered.orphanedRunningRuns) {
      ctx.logger?.warn?.(`[hams] \u542F\u52A8\u5BF9\u8D26\uFF1A\u53D6\u6D88\u6392\u961F ${recovered.cancelledQueuedRuns} \u4E2A / \u6807\u8BB0\u5B64\u513F ${recovered.orphanedRunningRuns} \u4E2A`);
    }
    ticker = createTicker({
      db,
      runtimeEpoch: runtime.report.runtimeEpoch,
      intervalMs: config.tickMs ?? 5e3,
      dataDir
    });
    ticker.start();
  }
  let dispatchTimer = null;
  if (sessionAdapter) {
    let dispatching = false;
    const writeMeta = (key, value) => {
      try {
        db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(key, typeof value === "string" ? value : JSON.stringify(value));
      } catch {
      }
    };
    dispatchTimer = setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      const startedAt2 = Date.now();
      writeMeta("dispatch:heartbeat", { at: startedAt2, dispatching: true });
      const cycle = Promise.resolve().then(() => sessionAdapter.dispatchAssignments()).then((report) => {
        if (report.errors.length) ctx.logger?.warn?.(`[hams] \u6307\u6D3E\u6D3E\u53D1\u5931\u8D25\uFF1A${report.errors.slice(0, 3).join(" | ")}`);
        writeMeta("dispatch:assign", { at: Date.now(), started: report.started, errors: report.errors.slice(0, 5) });
      }).then(() => sessionAdapter.dispatchQueued());
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("\u6D3E\u53D1\u5468\u671F\u8D85\u65F6\uFF0860s\uFF09")), 6e4);
      });
      Promise.race([cycle, timeout]).catch((error) => {
        writeMeta("dispatch:error", { at: Date.now(), error: String(error) });
        ctx.logger?.warn?.(`[hams] \u6D3E\u53D1\u5931\u8D25\uFF1A${String(error)}`);
      }).finally(() => {
        dispatching = false;
        writeMeta("dispatch:heartbeat", { at: Date.now(), dispatching: false });
      });
    }, Math.max(3e3, config.tickMs ?? 5e3));
    if (typeof dispatchTimer === "object" && dispatchTimer && "unref" in dispatchTimer) dispatchTimer.unref();
  }
  const routePaths = ROUTE_PATHS.map((path11) => `${API_PREFIX}${path11}`);
  let toolNames = [];
  try {
    if (config.toolsEnabled !== false && ctx.tools) {
      const definitions = createHamsTools({
        service,
        db,
        resolveSessionOwner: config.defaultBotMemberId ? () => ({ memberId: config.defaultBotMemberId }) : void 0,
        onAssigned: () => {
          if (!sessionAdapter) return;
          void sessionAdapter.dispatchAssignments().then((report) => {
            if (report.errors.length) ctx.logger?.warn?.(`[hams] \u6307\u6D3E\u5373\u65F6\u6D3E\u53D1\u5931\u8D25\uFF1A${report.errors.slice(0, 3).join(" | ")}`);
          }).then(() => sessionAdapter.dispatchQueued()).catch((error) => ctx.logger?.warn?.(`[hams] \u6307\u6D3E\u5373\u65F6\u6D3E\u53D1\u5931\u8D25\uFF1A${String(error)}`));
        },
        ...chat ? {
          chat: {
            projectOfSession: (sessionId) => chat.projectOfSession(sessionId),
            groupMembersBySession: (sessionId) => chat.groupMembersBySession(sessionId),
            groupSpeakBySession: (sessionId, input) => chat.groupSpeakBySession(sessionId, input),
            groupSpawnBySession: (sessionId, input) => chat.groupSpawnBySession(sessionId, input),
            noteAssignment: (sessionId, input) => chat.groupNoteAssignmentBySession(sessionId, input),
            rememberBySession: (sessionId, input) => chat.rememberBySession(sessionId, input)
          }
        } : {}
      });
      const hostTools = toHostTools(definitions);
      for (const tool of hostTools) {
        const disposer = ctx.tools.register(tool);
        if (typeof disposer === "function") disposers.push(disposer);
      }
      toolNames = definitions.map((definition) => definition.name);
    }
    const handler = createHamsHttpHandler({
      service,
      authenticate: createLocalAuthenticator(db, config, resolveConnection),
      readOnly: mode === "reader",
      ...chat ? { chat } : {},
      deliverables: { dataDir, db }
    });
    for (const path11 of routePaths) {
      const disposer = ctx.webServer.register({
        kind: "exact",
        path: path11,
        handler: async (req, res) => {
          try {
            const body = await readRequestBody(req);
            const response = await handler({
              method: req.method ?? "POST",
              path: path11,
              headers: toHeaderRecord(req.headers),
              body
            });
            writeResponse(res, response);
          } catch (error) {
            writeResponse(res, {
              status: 400,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ ok: false, error: { code: "STATE_INVALID", message: String(error?.message ?? error), nextStep: "\u68C0\u67E5\u8BF7\u6C42\u4F53\u5927\u5C0F\u540E\u91CD\u8BD5" } })
            });
          }
        }
      });
      if (typeof disposer === "function") disposers.push(disposer);
    }
  } catch (error) {
    while (disposers.length) {
      try {
        disposers.pop()?.();
      } catch {
      }
    }
    ticker?.stop();
    reader?.close();
    runtime?.close();
    throw error;
  }
  ctx.logger?.info?.(
    `[hams] ${mode === "writer" ? "\u5199\u8005" : "\u53EA\u8BFB"} \u6A21\u5F0F\u542F\u52A8\uFF1A${routePaths.length} \u6761\u8DEF\u7531 / ${toolNames.length} \u4E2A\u5DE5\u5177\uFF0C\u7528\u65F6 ${Date.now() - startedAt}ms\uFF0C\u6570\u636E\u76EE\u5F55 ${dataDir}\uFF0C\u4F1A\u8BDD\u6821\u9A8C ${sessionState}`
  );
  if (workspaceProfile && workspaceProfile.status !== "missing") {
    const summary = workspaceProfile.created;
    const line = `[hams] \u5DE5\u4F5C\u533A\u753B\u50CF ${workspaceProfile.status}\uFF1A\u6210\u5458 ${summary.members} / \u9879\u76EE ${summary.projects} / \u5DE5\u4F5C\u9879 ${summary.workItems} / \u6587\u6863 ${summary.docs} / \u6280\u80FD ${summary.skills} / \u8868 ${summary.tables} / \u6E05\u7406\u6A21\u677F ${summary.removedTemplates}${workspaceProfile.errors.length ? ` / \u9519\u8BEF ${workspaceProfile.errors.length}` : ""}${workspaceProfile.warnings.length ? ` / \u544A\u8B66 ${workspaceProfile.warnings.length}` : ""}`;
    if (workspaceProfile.status === "failed" || workspaceProfile.errors.length) ctx.logger?.warn?.(line);
    else ctx.logger?.info?.(line);
    for (const error of workspaceProfile.errors.slice(0, 5)) ctx.logger?.warn?.(`[hams] \u753B\u50CF\uFF1A${error}`);
    for (const warning of workspaceProfile.warnings.slice(0, 5)) ctx.logger?.warn?.(`[hams] \u753B\u50CF\u544A\u8B66\uFF1A${warning}`);
  }
  if (sessionState === "origin-only") {
    ctx.logger?.warn?.(
      "[hams] \u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B connection \u670D\u52A1\uFF1A\u754C\u9762\u63A5\u53E3\u53EA\u9A8C Origin\uFF0C\u4E0D\u6821\u9A8C\u5BBF\u4E3B\u6D4F\u89C8\u5668\u4F1A\u8BDD\u3002\u8981\u5F3A\u5236\u6821\u9A8C\uFF0C\u628A\u914D\u7F6E hostSession \u8BBE\u4E3A require\uFF08\u6216\u5728\u5E26 Web \u8F7D\u4F53\u7684\u5BBF\u4E3B\u91CC\u8FD0\u884C\uFF09\u3002"
    );
  }
  const registered2 = {
    mode,
    service,
    db,
    report: runtime?.report ?? null,
    ticker,
    routes: routePaths,
    toolNames,
    sessionState,
    operatorCapabilitiesAdded,
    workspaceProfile,
    defaultBots,
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose?.();
        } catch {
        }
      }
      ticker?.stop();
      if (dispatchTimer) clearInterval(dispatchTimer);
      void sessionAdapter?.dispose();
      reader?.close();
      runtime?.close();
      void chatRuntime?.dispose();
    }
  };
  return registered2;
}
function applyHams(ctx, config = {}) {
  if (typeof ctx.effect === "function") {
    let registered2 = null;
    ctx.effect(() => {
      registered2 = registerHams(ctx, config);
      return () => registered2?.dispose();
    }, "hams.runtime");
    return registered2;
  }
  return registerHams(ctx, config);
}

// src/index.js
var z = null;
try {
  ({ default: z } = await import("@deepseek-ai/schemastery"));
} catch (error) {
  console.error("[hams] \u65E0\u6CD5\u5BFC\u5165 @deepseek-ai/schemastery\uFF0C\u8DF3\u8FC7\u914D\u7F6E\u6821\u9A8C\uFF1A", error?.message ?? error);
}
var name = "hams";
var inject = ["tools", "webServer"];
var Config = z ? z.object({
  /** 数据目录；空 = $DSH_HOME/hams */
  dataDir: z.string().default(""),
  /** tick 周期（毫秒） */
  tickMs: z.number().default(5e3),
  /** 本机操作者 member id；空 = 查 hams_user(auth_source='local_host') */
  localPrincipalId: z.string().default(""),
  /** 首次认领时线程尚未建立，用它兜底（P1 单 bot） */
  defaultBotMemberId: z.string().default(""),
  /** 排障用：关掉工具或 tick */
  toolsEnabled: z.boolean().default(true),
  /** bot 运行时：单聊/群聊会话与工作项派发；默认开 */
  botRuntime: z.boolean().default(true),
  tickEnabled: z.boolean().default(true),
  /** 升级前备份保留份数 */
  backupKeep: z.number().default(3),
  /** 浏览器会话校验：auto = 宿主有 connection 就用它；require = 没有就拒绝；off = 只给测试 */
  hostSession: z.union([z.const("auto"), z.const("require"), z.const("off")]).default("auto"),
  /** 知识屏扫描的真实技能目录；空 = $DSH_HOME/skills */
  knowledgeSkillDirs: z.array(z.string()).default([]),
  /** 群聊里人类的任务请求自动登记成工作项；默认开 */
  autoIntake: z.boolean().default(true),
  /** 识别器模型；空 = 宿主默认模型 */
  intakeModel: z.string().default(""),
  /** 识别器推理强度；空 = 自动最低档 */
  intakeReasoningEffort: z.string().default(""),
  /** 工作区画像文件；空 = $DSH_HOME/hams/workspace-profile.json */
  workspaceProfileFile: z.string().default(""),
  /** 画像里相对路径的根；空 = 读画像里的 workspaceRoot */
  workspaceRoot: z.string().default("")
}) : void 0;
function apply(ctx, config = {}) {
  return applyHams(ctx, config ?? {});
}
export {
  Config,
  apply,
  inject,
  name
};
