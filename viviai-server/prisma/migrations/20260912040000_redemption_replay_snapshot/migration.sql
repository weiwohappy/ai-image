BEGIN;

ALTER TABLE redemption_claims
  ADD COLUMN response_snapshot jsonb;

COMMIT;
