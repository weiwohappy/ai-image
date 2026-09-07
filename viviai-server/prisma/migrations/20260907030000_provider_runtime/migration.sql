-- CreateTable
CREATE TABLE "ProviderAttempt" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "fence" INTEGER NOT NULL,
    "channelId" TEXT NOT NULL,
    "quotaScope" TEXT NOT NULL,
    "budgetKey" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitting',
    "acceptance" TEXT NOT NULL DEFAULT 'unknown',
    "billing" TEXT NOT NULL DEFAULT 'unknown',
    "providerRequestId" TEXT,
    "stagedKey" TEXT,
    "slotActive" BOOLEAN NOT NULL DEFAULT true,
    "unknownSlot" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostMicros" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderUsageRecord" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "certainty" TEXT NOT NULL DEFAULT 'unknown',
    "actualCostMicros" BIGINT,
    "lines" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProviderUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBudget" (
    "id" TEXT NOT NULL,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "consumedMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderQuota" (
    "id" TEXT NOT NULL,
    "inflight" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderAttempt_userId_slotActive_idx" ON "ProviderAttempt"("userId", "slotActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAttempt_itemId_ordinal_key" ON "ProviderAttempt"("itemId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderUsageRecord_attemptId_key" ON "ProviderUsageRecord"("attemptId");

-- AddForeignKey
ALTER TABLE "ProviderAttempt" ADD CONSTRAINT "ProviderAttempt_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "GenerationItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderUsageRecord" ADD CONSTRAINT "ProviderUsageRecord_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ProviderAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ProviderBudget" ADD CONSTRAINT "budget_nonnegative" CHECK ("reservedMicros" >= 0 AND "consumedMicros" >= 0);
ALTER TABLE "ProviderQuota" ADD CONSTRAINT "quota_nonnegative" CHECK ("inflight" >= 0 AND "unknown" >= 0 AND "unknown" <= "inflight");
ALTER TABLE "ProviderAttempt" ADD CONSTRAINT "attempt_bounded" CHECK ("ordinal" IN (0,1) AND "estimatedCostMicros" > 0 AND "acceptance" IN ('not_accepted','accepted','unknown') AND "billing" IN ('not_billable','billable','unknown'));
ALTER TABLE "ProviderUsageRecord" ADD CONSTRAINT "usage_valid" CHECK ("certainty" IN ('not_billable','billable','unknown') AND ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0));
