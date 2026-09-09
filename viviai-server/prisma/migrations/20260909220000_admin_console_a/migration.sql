-- CreateTable
CREATE TABLE "AdminAccount" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "roles" TEXT[],
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedMfaSecret" TEXT NOT NULL,
    "lastTotpCounter" BIGINT,
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAccount_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminInvitation" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roles" TEXT[],
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInvitation_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminChallenge" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminChallenge_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminAuditEvent" (
    "id" UUID NOT NULL,
    "accountId" UUID,
    "sessionId" UUID,
    "action" TEXT NOT NULL,
    "resourceId" TEXT,
    "outcome" TEXT NOT NULL,
    "reasonDigest" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminSensitiveGrant" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "reasonDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSensitiveGrant_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AdminAlert" (
    "id" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "GenerationLifecycleEvent" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationLifecycleEvent_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "AdminAccount_email_key" ON "AdminAccount"("email");
-- CreateIndex
CREATE UNIQUE INDEX "AdminInvitation_tokenHash_key" ON "AdminInvitation"("tokenHash");
-- CreateIndex
CREATE UNIQUE INDEX "AdminInvitation_email_key" ON "AdminInvitation"("email");
-- CreateIndex
CREATE UNIQUE INDEX "AdminChallenge_tokenHash_key" ON "AdminChallenge"("tokenHash");
-- CreateIndex
CREATE INDEX "AdminChallenge_accountId_idx" ON "AdminChallenge"("accountId");
-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
-- CreateIndex
CREATE INDEX "AdminSession_accountId_idx" ON "AdminSession"("accountId");
-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");
-- CreateIndex
CREATE INDEX "AdminRecoveryCode_accountId_idx" ON "AdminRecoveryCode"("accountId");
-- CreateIndex
CREATE INDEX "AdminAuditEvent_createdAt_id_idx" ON "AdminAuditEvent"("createdAt", "id");
-- CreateIndex
CREATE UNIQUE INDEX "AdminAlert_sourceKey_key" ON "AdminAlert"("sourceKey");
-- CreateIndex
CREATE INDEX "AdminAlert_createdAt_id_idx" ON "AdminAlert"("createdAt", "id");
-- CreateIndex
CREATE UNIQUE INDEX "GenerationLifecycleEvent_itemId_event_key" ON "GenerationLifecycleEvent"("itemId", "event");

CREATE FUNCTION admin_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Admin audit events are append only'; END $$;
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON "AdminAuditEvent" FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();
ALTER TABLE "AdminAccount" ADD CONSTRAINT admin_status CHECK (status IN ('pending','active','disabled'));
ALTER TABLE "AdminAccount" ADD CONSTRAINT admin_email_normalized CHECK (email = lower(email));
ALTER TABLE "AdminAccount" ADD CONSTRAINT admin_roles CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['owner','support','finance','model_operator','content_operator','system_admin']::text[] AND "extraPermissions" <@ ARRAY['sensitive.read']::text[]);
ALTER TABLE "AdminInvitation" ADD CONSTRAINT admin_invite_roles CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['owner','support','finance','model_operator','content_operator','system_admin']::text[] AND "extraPermissions" <@ ARRAY['sensitive.read']::text[]);
ALTER TABLE "AdminChallenge" ADD FOREIGN KEY ("accountId") REFERENCES "AdminAccount"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminSession" ADD FOREIGN KEY ("accountId") REFERENCES "AdminAccount"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminRecoveryCode" ADD FOREIGN KEY ("accountId") REFERENCES "AdminAccount"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminSensitiveGrant" ADD FOREIGN KEY ("accountId") REFERENCES "AdminAccount"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminSensitiveGrant" ADD FOREIGN KEY ("sessionId") REFERENCES "AdminSession"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminSensitiveGrant" ADD FOREIGN KEY ("jobId") REFERENCES "GenerationJob"(id) ON DELETE RESTRICT;
ALTER TABLE "GenerationLifecycleEvent" ADD FOREIGN KEY ("itemId") REFERENCES "GenerationItem"(id) ON DELETE RESTRICT;
ALTER TABLE "AdminSensitiveGrant" ADD COLUMN reason VARCHAR(500) NOT NULL;
ALTER TABLE "AdminSensitiveGrant" ADD CONSTRAINT admin_reason_length CHECK (char_length(reason) BETWEEN 10 AND 500);
