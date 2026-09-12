BEGIN;

ALTER TABLE users
  ADD COLUMN avatar_asset_id uuid,
  ADD COLUMN invite_code text,
  ADD COLUMN invited_by_user_id uuid,
  ADD COLUMN updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE users
  SET invite_code = upper(replace(id::text, '-', ''))
  WHERE invite_code IS NULL;

ALTER TABLE users
  ALTER COLUMN invite_code SET NOT NULL,
  ADD CONSTRAINT users_invite_code_key UNIQUE (invite_code),
  ADD CONSTRAINT users_avatar_asset_id_key UNIQUE (avatar_asset_id),
  ADD CONSTRAINT users_avatar_asset_id_fkey
    FOREIGN KEY (avatar_asset_id) REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT users_invited_by_user_id_fkey
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  action jsonb,
  read_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX notifications_user_id_read_at_created_at_idx ON notifications(user_id, read_at, created_at);

CREATE TABLE referrals (
  id uuid PRIMARY KEY,
  inviter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  invitee_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  reward_credits integer NOT NULL DEFAULT 100 CHECK (reward_credits >= 0),
  qualified_at timestamptz(6),
  rewarded_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX referrals_inviter_user_id_created_at_idx ON referrals(inviter_user_id, created_at);

CREATE TABLE redemption_campaigns (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  starts_at timestamptz(6) NOT NULL,
  ends_at timestamptz(6) NOT NULL,
  per_user_limit integer NOT NULL DEFAULT 1 CHECK (per_user_limit >= 0),
  credits integer NOT NULL CHECK (credits >= 0),
  total_limit integer CHECK (total_limit >= 0),
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT redemption_campaigns_valid_period CHECK (ends_at > starts_at)
);
CREATE INDEX redemption_campaigns_status_starts_at_ends_at_idx ON redemption_campaigns(status, starts_at, ends_at);

CREATE TABLE redemption_codes (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES redemption_campaigns(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  digest text NOT NULL UNIQUE,
  display_mask text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  max_uses integer NOT NULL CHECK (max_uses >= 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX redemption_codes_campaign_id_status_idx ON redemption_codes(campaign_id, status);

CREATE TABLE redemption_claims (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  code_id uuid NOT NULL REFERENCES redemption_codes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  credits integer NOT NULL CHECK (credits >= 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT redemption_claims_user_id_code_id_key UNIQUE (user_id, code_id)
);
CREATE INDEX redemption_claims_code_id_created_at_idx ON redemption_claims(code_id, created_at);

COMMIT;
