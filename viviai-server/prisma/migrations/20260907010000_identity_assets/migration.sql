CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, username text NOT NULL UNIQUE,
 password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE TABLE email_challenges (
 email text NOT NULL, purpose text NOT NULL, code_hash text NOT NULL, salt text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL, sent_at timestamptz NOT NULL, consumed_at timestamptz,
 PRIMARY KEY(email,purpose), CHECK (purpose IN ('register','reset-password'))
);
CREATE TABLE auth_rate_buckets (key text PRIMARY KEY, count integer NOT NULL CHECK(count > 0), expires_at timestamptz NOT NULL);
CREATE TABLE assets (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 name text NOT NULL, object_key text NOT NULL UNIQUE, width integer NOT NULL CHECK(width > 0),
 height integer NOT NULL CHECK(height > 0), byte_size integer NOT NULL CHECK(byte_size > 0),
 content_type text NOT NULL, status text NOT NULL DEFAULT 'ready', favorite boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX assets_user_id_deleted_at_created_at_idx ON assets(user_id,deleted_at,created_at);
