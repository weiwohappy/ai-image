-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "sha256" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'upload';

-- CreateTable
CREATE TABLE "GenerationQuote" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "productVersion" TEXT NOT NULL,
    "unitCredits" BIGINT NOT NULL,
    "totalCredits" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),

    CONSTRAINT "GenerationQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "retryOfJobId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "queueDeadlineAt" TIMESTAMPTZ(6) NOT NULL,
    "deliveryDeadlineAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationItem" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "unitCredits" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "fence" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(6),
    "nextRunAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultAssetId" UUID,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GenerationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetPin" (
    "jobId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "AssetPin_pkey" PRIMARY KEY ("jobId","assetId")
);

-- CreateTable
CREATE TABLE "CreditLot" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceId" TEXT NOT NULL,
    "issued" BIGINT NOT NULL,
    "available" BIGINT NOT NULL,
    "held" BIGINT NOT NULL DEFAULT 0,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "expired" BIGINT NOT NULL DEFAULT 0,
    "revoked" BIGINT NOT NULL DEFAULT 0,
    "revenueMinor" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditReservation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditAllocation" (
    "reservationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "CreditAllocation_pkey" PRIMARY KEY ("reservationId","lotId")
);

-- CreateTable
CREATE TABLE "CreditEvent" (
    "id" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "itemId" UUID,
    "availableDelta" BIGINT NOT NULL DEFAULT 0,
    "heldDelta" BIGINT NOT NULL DEFAULT 0,
    "consumedDelta" BIGINT NOT NULL DEFAULT 0,
    "expiredDelta" BIGINT NOT NULL DEFAULT 0,
    "revokedDelta" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "itemId" UUID NOT NULL,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationQuote_userId_expiresAt_idx" ON "GenerationQuote"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_quoteId_key" ON "GenerationJob"("quoteId");

-- CreateIndex
CREATE INDEX "GenerationJob_userId_createdAt_idx" ON "GenerationJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_userId_operation_idempotencyKey_key" ON "GenerationJob"("userId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationItem_resultAssetId_key" ON "GenerationItem"("resultAssetId");

-- CreateIndex
CREATE INDEX "GenerationItem_status_nextRunAt_idx" ON "GenerationItem"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationItem_jobId_ordinal_key" ON "GenerationItem"("jobId", "ordinal");

-- CreateIndex
CREATE INDEX "CreditLot_userId_expiresAt_idx" ON "CreditLot"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLot_userId_sourceId_key" ON "CreditLot"("userId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_itemId_key" ON "CreditReservation"("itemId");

-- CreateIndex
CREATE INDEX "CreditReservation_userId_status_idx" ON "CreditReservation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditEvent_eventKey_key" ON "CreditEvent"("eventKey");

-- CreateIndex
CREATE INDEX "CreditEvent_userId_createdAt_idx" ON "CreditEvent"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_eventKey_key" ON "OutboxEvent"("eventKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");

-- AddForeignKey
ALTER TABLE "GenerationQuote" ADD CONSTRAINT "GenerationQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "GenerationQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationItem" ADD CONSTRAINT "GenerationItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetPin" ADD CONSTRAINT "AssetPin_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetPin" ADD CONSTRAINT "AssetPin_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "GenerationItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "CreditReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "CreditLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEvent" ADD CONSTRAINT "CreditEvent_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "CreditLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ledger conservation and state invariants, enforced even outside application code.
ALTER TABLE "CreditLot" ADD CONSTRAINT "credit_lot_conserved" CHECK ("issued" > 0 AND "available" >= 0 AND "held" >= 0 AND "consumed" >= 0 AND "expired" >= 0 AND "revoked" >= 0 AND "revenueMinor" >= 0 AND "issued" = "available" + "held" + "consumed" + "expired" + "revoked");
ALTER TABLE "CreditReservation" ADD CONSTRAINT "credit_reservation_valid" CHECK ("amount" > 0 AND "status" IN ('held','consumed','released'));
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "credit_allocation_positive" CHECK ("amount" > 0);
ALTER TABLE "GenerationQuote" ADD CONSTRAINT "quote_positive" CHECK ("unitCredits" > 0 AND "totalCredits" >= "unitCredits" AND "expiresAt" > "createdAt");
ALTER TABLE "GenerationItem" ADD CONSTRAINT "item_valid" CHECK ("unitCredits" > 0 AND "ordinal" >= 0 AND "fence" >= 0 AND "status" IN ('queued','submitting','pending','unknown','materializing','succeeded','failed','cancelled'));
ALTER TABLE "AssetPin" ADD CONSTRAINT "asset_pin_role" CHECK ("role" IN ('reference','subject'));
