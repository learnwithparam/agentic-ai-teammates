-- The input tokens a provider read from its prompt cache, per model call and per run. They are
-- the evidence that putting the fixed part of each call first pays off.
ALTER TABLE spend ADD COLUMN cached_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cached_tokens integer NOT NULL DEFAULT 0;
