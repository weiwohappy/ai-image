BEGIN;

ALTER TABLE redemption_codes
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT redemption_codes_version_check CHECK (version > 0);

CREATE TEMP TABLE marketing_changed_roles ON COMMIT DROP AS
  SELECT "key"
  FROM "AdminRole"
  WHERE "builtIn" = true
    AND "key" IN ('super_admin', 'owner')
    AND NOT (
      ARRAY['redemptions.read', 'redemptions.write', 'referrals.read']::text[] <@ "permissions"
    );

UPDATE "AdminRole"
SET "permissions" = ARRAY(
      SELECT DISTINCT permission
      FROM unnest(
        "permissions" || ARRAY['redemptions.read', 'redemptions.write', 'referrals.read']::text[]
      ) AS permission
      ORDER BY permission
    ),
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN (SELECT "key" FROM marketing_changed_roles);

CREATE TEMP TABLE marketing_affected_accounts ON COMMIT DROP AS
  SELECT DISTINCT "accountId"
  FROM "AdminAccountRole"
  WHERE "roleKey" IN (SELECT "key" FROM marketing_changed_roles);

UPDATE "AdminAccount"
SET "authVersion" = "authVersion" + 1,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "accountId" FROM marketing_affected_accounts);

UPDATE "AdminSession"
SET "expiresAt" = to_timestamp(0)
WHERE "accountId" IN (SELECT "accountId" FROM marketing_affected_accounts);

DELETE FROM "AdminChallenge"
WHERE "accountId" IN (SELECT "accountId" FROM marketing_affected_accounts);

DELETE FROM "AdminSensitiveGrant"
WHERE "accountId" IN (SELECT "accountId" FROM marketing_affected_accounts);

UPDATE "AdminPasswordReset"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "accountId" IN (SELECT "accountId" FROM marketing_affected_accounts)
  AND "consumedAt" IS NULL
  AND "revokedAt" IS NULL;

UPDATE "AdminInvitation"
SET "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "consumedAt" IS NULL
  AND "id" IN (
    SELECT "invitationId"
    FROM "AdminInvitationRole"
    WHERE "roleKey" IN (SELECT "key" FROM marketing_changed_roles)
  );

COMMIT;
