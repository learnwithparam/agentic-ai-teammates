-- News can go to Mission Control's own news page or to GitHub Pages, so its outbox target is
-- named for what it does, not for one of the places it goes.
ALTER TABLE outbox DROP CONSTRAINT outbox_target_check;
UPDATE outbox SET target = 'news.publish' WHERE target = 'github.publish';
ALTER TABLE outbox ADD CONSTRAINT outbox_target_check CHECK (target IN ('lmail.send', 'news.publish'));
