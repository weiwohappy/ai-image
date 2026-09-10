BEGIN;
CREATE TABLE "ModelCreditPrice" (
  "id" UUID PRIMARY KEY,
  "modelId" VARCHAR(80) NOT NULL CHECK (length("modelId") BETWEEN 1 AND 80),
  "resolution" VARCHAR(16) NOT NULL CHECK (length("resolution") BETWEEN 1 AND 16),
  "unitCredits" INTEGER NOT NULL CHECK ("unitCredits" BETWEEN 1 AND 1000000),
  "enabled" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" UUID REFERENCES "AdminAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ModelCreditPrice_modelId_resolution_key" ON "ModelCreditPrice"("modelId", "resolution");
ALTER TABLE "GenerationQuote" ADD COLUMN "creditPriceSnapshot" JSONB;
ALTER TABLE "GenerationJob" ADD COLUMN "creditPriceSnapshot" JSONB;
-- Only the existing built-in super administrator gains the capability. No prices are seeded.
CREATE TEMP TABLE pricing_changed_roles ON COMMIT DROP AS
  SELECT "key" FROM "AdminRole" WHERE "key"='super_admin' AND "builtIn"=true
    AND NOT ('model-pricing.write'=ANY("permissions"));
UPDATE "AdminRole" SET "permissions"=array_append("permissions", 'model-pricing.write'),
  "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP
  WHERE "key" IN (SELECT "key" FROM pricing_changed_roles);
CREATE TEMP TABLE pricing_affected_accounts ON COMMIT DROP AS
  SELECT DISTINCT "accountId" FROM "AdminAccountRole" WHERE "roleKey" IN (SELECT "key" FROM pricing_changed_roles);
UPDATE "AdminAccount" SET "authVersion"="authVersion"+1, "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP
  WHERE "id" IN (SELECT "accountId" FROM pricing_affected_accounts);
UPDATE "AdminSession" SET "expiresAt"=to_timestamp(0) WHERE "accountId" IN (SELECT "accountId" FROM pricing_affected_accounts);
DELETE FROM "AdminChallenge" WHERE "accountId" IN (SELECT "accountId" FROM pricing_affected_accounts);
DELETE FROM "AdminSensitiveGrant" WHERE "accountId" IN (SELECT "accountId" FROM pricing_affected_accounts);
UPDATE "AdminPasswordReset" SET "revokedAt"=CURRENT_TIMESTAMP
  WHERE "accountId" IN (SELECT "accountId" FROM pricing_affected_accounts) AND "consumedAt" IS NULL AND "revokedAt" IS NULL;
UPDATE "AdminInvitation" SET "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP
  WHERE "consumedAt" IS NULL AND "id" IN (SELECT "invitationId" FROM "AdminInvitationRole" WHERE "roleKey" IN (SELECT "key" FROM pricing_changed_roles));
COMMIT;
