BEGIN;

ALTER TABLE notifications
  ADD COLUMN event_key text,
  ADD CONSTRAINT notifications_event_key_key UNIQUE (event_key);

COMMIT;
