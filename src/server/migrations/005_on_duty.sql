-- A teammate on duty gets its kind's daily schedules. The eval teammate is not on duty: it
-- scores invoices on demand and must never mail anyone.
ALTER TABLE teammates ADD COLUMN on_duty boolean NOT NULL DEFAULT true;
