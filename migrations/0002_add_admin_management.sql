ALTER TABLE leave_share_records ADD COLUMN share_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_share_records_share_id
ON leave_share_records(share_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_share_records_student_id
ON leave_share_records(student_id);

CREATE TABLE IF NOT EXISTS admin_members (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'member')),
    student_id TEXT UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1
        CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (role = 'owner' OR student_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_admin_members_student_id
ON admin_members(student_id);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
        'create', 'update', 'disable', 'restore',
        'member_upsert', 'member_disable'
    )),
    token_hash TEXT,
    student_id TEXT,
    student_name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
ON admin_audit_log(created_at DESC);

PRAGMA optimize;
