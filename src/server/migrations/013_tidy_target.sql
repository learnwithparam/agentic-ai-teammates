-- The weekly tidy's proposals wait in the outbox as drafts, so the outbox accepts their target.
ALTER TABLE outbox DROP CONSTRAINT outbox_target_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_target_check CHECK (target IN ('lmail.send', 'news.publish', 'memory.tidy'));
