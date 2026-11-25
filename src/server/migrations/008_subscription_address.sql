-- The hooks address each subscription points at. When HOOKS_URL changes, the gateway sees the
-- old address here and moves the subscription at once, instead of waiting for it to run out.
ALTER TABLE subscriptions ADD COLUMN address text;
