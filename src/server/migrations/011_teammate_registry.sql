-- A teammate's kind is any kind the code defines. The list lives in src/server/teammates/registry.ts,
-- and startup gives each company the teammates it is missing, so the database no longer repeats it.
ALTER TABLE teammates DROP CONSTRAINT IF EXISTS teammates_kind_check;

-- No code ever read or wrote this table. The conversation table holds what a person and a teammate say.
DROP TABLE IF EXISTS chat_messages;
