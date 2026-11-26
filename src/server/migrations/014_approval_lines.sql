-- The items a person approves, one line each, read from the books by the tool's own checks.
ALTER TABLE approvals ADD COLUMN lines jsonb NOT NULL DEFAULT '[]';
