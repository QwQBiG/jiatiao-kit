ALTER TABLE leave_share_records ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'array');

CREATE TABLE leave_attachment_usage (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    total_bytes INTEGER NOT NULL DEFAULT 0
        CONSTRAINT attachment_storage_quota CHECK (total_bytes BETWEEN 0 AND 134217728),
    manifest_guard INTEGER NOT NULL DEFAULT 1
        CONSTRAINT attachment_manifest_conflict CHECK (manifest_guard = 1)
);
INSERT INTO leave_attachment_usage (singleton) VALUES (1);

CREATE TABLE leave_record_attachments (
    token_hash TEXT NOT NULL REFERENCES leave_share_records(token_hash) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL CHECK (length(attachment_id) = 32),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 192),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 192),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 24576),
    thumbnail BLOB NOT NULL CHECK (typeof(thumbnail) = 'blob' AND length(thumbnail) = byte_size),
    PRIMARY KEY (token_hash, attachment_id)
);

CREATE TRIGGER leave_attachment_count BEFORE INSERT ON leave_record_attachments
WHEN (SELECT COUNT(*) FROM leave_record_attachments WHERE token_hash = NEW.token_hash) >= 3
BEGIN
    SELECT RAISE(ABORT, 'ATTACHMENT_LIMIT_EXCEEDED');
END;
CREATE TRIGGER leave_attachment_insert_usage AFTER INSERT ON leave_record_attachments
BEGIN
    UPDATE leave_attachment_usage SET total_bytes = total_bytes + NEW.byte_size WHERE singleton = 1;
END;
CREATE TRIGGER leave_attachment_delete_usage AFTER DELETE ON leave_record_attachments
BEGIN
    UPDATE leave_attachment_usage SET total_bytes = total_bytes - OLD.byte_size WHERE singleton = 1;
END;
CREATE TRIGGER leave_attachment_update_usage AFTER UPDATE OF byte_size ON leave_record_attachments
BEGIN
    UPDATE leave_attachment_usage SET total_bytes = total_bytes + NEW.byte_size - OLD.byte_size
    WHERE singleton = 1;
END;
