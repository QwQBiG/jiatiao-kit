-- Student profiles are current data; leave_share_records keeps each leave's snapshot.
CREATE TABLE students (
    student_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    gender TEXT NOT NULL,
    grade TEXT NOT NULL,
    college TEXT NOT NULL,
    major TEXT NOT NULL,
    class_name TEXT NOT NULL,
    dorm TEXT NOT NULL DEFAULT '-',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO students
    (student_id, name, short_name, gender, grade, college, major, class_name,
     dorm, created_at, updated_at)
SELECT student_id, name, short_name, gender, grade, college, major, class_name,
    dorm, created_at, updated_at
FROM (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY student_id ORDER BY created_at DESC, rowid DESC
    ) AS position
    FROM leave_share_records
) WHERE position = 1;

DROP INDEX idx_leave_share_records_student_id;
CREATE INDEX idx_leave_share_records_student_history
    ON leave_share_records(student_id, created_at DESC);

-- All writers, including the CLI and D1 console, share the same retention rule.
-- Updates keep their original creation order. Equal timestamps use insertion order.
CREATE TRIGGER leave_records_after_insert
AFTER INSERT ON leave_share_records
BEGIN
    INSERT INTO students
        (student_id, name, short_name, gender, grade, college, major, class_name,
         dorm, created_at, updated_at)
    VALUES (NEW.student_id, NEW.name, NEW.short_name, NEW.gender, NEW.grade,
        NEW.college, NEW.major, NEW.class_name, NEW.dorm, NEW.created_at, NEW.updated_at)
    ON CONFLICT(student_id) DO UPDATE SET
        name = excluded.name, short_name = excluded.short_name,
        gender = excluded.gender, grade = excluded.grade, college = excluded.college,
        major = excluded.major, class_name = excluded.class_name,
        dorm = excluded.dorm, updated_at = excluded.updated_at;

    DELETE FROM leave_share_records
    WHERE token_hash IN (
        SELECT token_hash FROM leave_share_records WHERE student_id = NEW.student_id
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 100
    );
END;

-- Updating one snapshot does not rewrite any other historical record.
CREATE TRIGGER leave_records_after_profile_update
AFTER UPDATE OF student_id, name, short_name, gender, grade, college,
    major, class_name, dorm ON leave_share_records
WHEN NEW.student_id IS NOT OLD.student_id OR NEW.name IS NOT OLD.name
    OR NEW.short_name IS NOT OLD.short_name OR NEW.gender IS NOT OLD.gender
    OR NEW.grade IS NOT OLD.grade OR NEW.college IS NOT OLD.college
    OR NEW.major IS NOT OLD.major OR NEW.class_name IS NOT OLD.class_name
    OR NEW.dorm IS NOT OLD.dorm
BEGIN
    INSERT INTO students
        (student_id, name, short_name, gender, grade, college, major, class_name,
         dorm, created_at, updated_at)
    VALUES (NEW.student_id, NEW.name, NEW.short_name, NEW.gender, NEW.grade,
        NEW.college, NEW.major, NEW.class_name, NEW.dorm, NEW.created_at, NEW.updated_at)
    ON CONFLICT(student_id) DO UPDATE SET
        name = excluded.name, short_name = excluded.short_name,
        gender = excluded.gender, grade = excluded.grade, college = excluded.college,
        major = excluded.major, class_name = excluded.class_name,
        dorm = excluded.dorm, updated_at = excluded.updated_at;
END;

CREATE TRIGGER leave_records_after_student_change
AFTER UPDATE OF student_id ON leave_share_records
WHEN NEW.student_id IS NOT OLD.student_id
BEGIN
    DELETE FROM leave_share_records
    WHERE token_hash IN (
        SELECT token_hash FROM leave_share_records WHERE student_id = NEW.student_id
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 100
    );
END;

DELETE FROM leave_share_records WHERE rowid IN (
    SELECT record_rowid FROM (
        SELECT rowid AS record_rowid, ROW_NUMBER() OVER (
            PARTITION BY student_id ORDER BY created_at DESC, rowid DESC
        ) AS position FROM leave_share_records
    ) WHERE position > 100
);
