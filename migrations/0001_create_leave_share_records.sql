CREATE TABLE IF NOT EXISTS leave_share_records (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    student_id TEXT NOT NULL,
    gender TEXT NOT NULL,
    grade TEXT NOT NULL,
    college TEXT NOT NULL,
    major TEXT NOT NULL,
    class_name TEXT NOT NULL,
    dorm TEXT NOT NULL DEFAULT '-',
    leave_type TEXT NOT NULL,
    need_leave_school INTEGER NOT NULL DEFAULT 0
        CHECK (need_leave_school IN (0, 1)),
    approver TEXT NOT NULL,
    reason TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('approved', 'pending', 'rejected')),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    revoked_at TEXT,
    CHECK (start_at < end_at)
);
