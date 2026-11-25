-- Like Gmail's users.watch, a client holds one watch per mailbox. Watching again from a new
-- address moves the watch there, so an address the client left gets no more notices.
DELETE FROM watches w
USING watches newer
WHERE newer.mailbox = w.mailbox AND newer.client = w.client AND newer.expires_at > w.expires_at;

ALTER TABLE watches DROP CONSTRAINT watches_pkey;
ALTER TABLE watches ADD PRIMARY KEY (mailbox, client);
