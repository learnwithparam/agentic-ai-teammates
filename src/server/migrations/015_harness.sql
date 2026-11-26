-- A teammate the eval or the attack scripts run. It does no work for a person, so the board
-- never shows it and nobody decides its cards.
ALTER TABLE teammates ADD COLUMN harness boolean NOT NULL DEFAULT false;
UPDATE teammates SET harness = true WHERE id LIKE '%-eval' OR id LIKE '%-attack';
