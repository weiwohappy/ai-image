-- Atomic conversion: never discard an unrecognized legacy grant.
BEGIN;
DO $$ DECLARE bad RECORD; BEGIN
 SELECT id INTO bad FROM "AdminAccount" WHERE roles IS NULL OR cardinality(roles)=0 OR NOT roles <@ ARRAY['owner','support','finance','model_operator','content_operator','system_admin']::text[] LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'Unknown or empty legacy administrator roles for account %', bad.id; END IF;
 SELECT id INTO bad FROM "AdminInvitation" WHERE roles IS NULL OR cardinality(roles)=0 OR NOT roles <@ ARRAY['owner','support','finance','model_operator','content_operator','system_admin']::text[] LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'Unknown or empty legacy invitation roles for invitation %', bad.id; END IF;
END $$;
CREATE TABLE "AdminRole" (
 "key" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '',
 "builtIn" BOOLEAN NOT NULL DEFAULT false, "permissions" TEXT[] NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1, "deletedAt" TIMESTAMPTZ(6),
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('super_admin','超级管理员',true,ARRAY['dashboard.read','users.read','orders.read','credits.read','jobs.read','models.read','providers.read','costs.read','alerts.read','audit.read','admins.read','dashboard.business.read','dashboard.finance.read','dashboard.models.read','dashboard.system.read','dashboard.content.read','alerts.service.read','alerts.model.read','admins.create','admins.update','admins.roles.assign','admins.status.update','admins.password.reset','roles.read','roles.create','roles.update','roles.delete']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('owner','业务负责人',true,ARRAY['dashboard.read','users.read','orders.read','credits.read','jobs.read','models.read','providers.read','costs.read','alerts.read','audit.read','admins.read','dashboard.business.read','dashboard.finance.read','dashboard.models.read','dashboard.system.read','alerts.service.read','alerts.model.read','admins.create','admins.update','admins.roles.assign','admins.status.update','admins.password.reset','roles.read']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('support','客服',true,ARRAY['dashboard.read','users.read','orders.read','credits.read','jobs.read','alerts.read','dashboard.business.read','alerts.service.read']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('finance','财务',true,ARRAY['dashboard.read','users.read','orders.read','credits.read','jobs.read','costs.read','dashboard.business.read','dashboard.finance.read']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('model_operator','模型运营',true,ARRAY['dashboard.read','models.read','providers.read','costs.read','alerts.read','dashboard.models.read','alerts.model.read']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('content_operator','内容运营',true,ARRAY['dashboard.read','dashboard.content.read']);
INSERT INTO "AdminRole" ("key","name","builtIn","permissions") VALUES ('system_admin','系统管理员',true,ARRAY['dashboard.read','audit.read','admins.read','dashboard.system.read','admins.create','admins.update','admins.roles.assign','admins.status.update','admins.password.reset','roles.read']);
CREATE TABLE "AdminAccountRole" (
 "accountId" UUID NOT NULL REFERENCES "AdminAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "roleKey" TEXT NOT NULL REFERENCES "AdminRole"("key") ON DELETE RESTRICT ON UPDATE CASCADE,
 PRIMARY KEY ("accountId","roleKey")
);
CREATE TABLE "AdminInvitationRole" (
 "invitationId" UUID NOT NULL REFERENCES "AdminInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "roleKey" TEXT NOT NULL REFERENCES "AdminRole"("key") ON DELETE RESTRICT ON UPDATE CASCADE,
 PRIMARY KEY ("invitationId","roleKey")
);
INSERT INTO "AdminAccountRole" SELECT DISTINCT id, unnest(roles) FROM "AdminAccount";
INSERT INTO "AdminInvitationRole" SELECT DISTINCT id, unnest(roles) FROM "AdminInvitation";
ALTER TABLE "AdminAccount" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "disabledAt" TIMESTAMPTZ(6);
UPDATE "AdminAccount" SET "disabledAt"=CURRENT_TIMESTAMP, status=CASE WHEN "lastTotpCounter" IS NOT NULL THEN 'active' ELSE 'pending' END WHERE status='disabled';
ALTER TABLE "AdminAccount" DROP CONSTRAINT admin_status, DROP COLUMN roles;
ALTER TABLE "AdminAccount" ADD CONSTRAINT admin_status CHECK (status IN ('pending','active'));
ALTER TABLE "AdminAccount" ADD CONSTRAINT admin_extras CHECK ("extraPermissions" <@ ARRAY['sensitive.read']::text[]);
ALTER TABLE "AdminInvitation" ADD COLUMN "displayName" TEXT NOT NULL DEFAULT '',
 ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "revokedAt" TIMESTAMPTZ(6), ADD COLUMN "createdBy" UUID, DROP COLUMN roles;
UPDATE "AdminInvitation" SET "displayName"=email;
ALTER TABLE "AdminInvitation" ADD CONSTRAINT admin_invite_extras CHECK ("extraPermissions" <@ ARRAY['sensitive.read']::text[]);
CREATE TABLE "AdminPasswordReset" (
 "id" UUID PRIMARY KEY, "accountId" UUID NOT NULL REFERENCES "AdminAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "tokenHash" TEXT NOT NULL UNIQUE, "expiresAt" TIMESTAMPTZ(6) NOT NULL, "consumedAt" TIMESTAMPTZ(6),
 "revokedAt" TIMESTAMPTZ(6), "createdBy" UUID NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AdminPasswordReset_accountId_idx" ON "AdminPasswordReset"("accountId");
CREATE TABLE "AdminCommandReceipt" (
 "id" UUID PRIMARY KEY, "accountId" UUID NOT NULL, "sessionId" UUID NOT NULL, "idempotencyKey" UUID NOT NULL,
 "action" TEXT NOT NULL, "target" TEXT NOT NULL, "requestDigest" TEXT NOT NULL, "result" JSONB NOT NULL,
 "completedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("accountId","idempotencyKey")
);
ALTER TABLE "AdminAuditEvent" ADD COLUMN metadata JSONB;
COMMIT;
