BEGIN;

ALTER TABLE email_challenges
  DROP CONSTRAINT email_challenges_purpose_check,
  ADD CONSTRAINT email_challenges_purpose_check
    CHECK (purpose IN ('register', 'reset-password', 'change-email', 'change-password'));

COMMIT;
