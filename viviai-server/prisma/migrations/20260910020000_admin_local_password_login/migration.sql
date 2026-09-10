-- Existing sessions were issued only after MFA; local sessions are explicitly distinguished.
ALTER TABLE "AdminSession" ADD COLUMN "authMethod" TEXT NOT NULL DEFAULT 'mfa';
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_authMethod_check"
  CHECK ("authMethod" IN ('mfa', 'local_password'));
