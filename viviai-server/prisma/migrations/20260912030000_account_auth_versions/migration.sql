BEGIN;

ALTER TABLE users
  ADD COLUMN auth_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_auth_version_check CHECK (auth_version > 0);

ALTER TABLE sessions
  ADD COLUMN auth_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT sessions_auth_version_check CHECK (auth_version > 0);

COMMIT;
