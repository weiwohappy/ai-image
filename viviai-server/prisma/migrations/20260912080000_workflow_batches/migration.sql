BEGIN;

-- CreateTable
CREATE TABLE "Workflow" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRow" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "rowKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,

    CONSTRAINT "WorkflowRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRunQuote" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workflowId" UUID,
    "inputHash" TEXT NOT NULL,
    "workflowVersion" INTEGER NOT NULL,
    "totalCredits" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowRunQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRunQuoteItem" (
    "id" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "rowKey" TEXT NOT NULL,
    "columnKey" TEXT NOT NULL,
    "normalizedInput" JSONB NOT NULL,
    "originSnapshot" JSONB NOT NULL,
    "unitCredits" BIGINT NOT NULL,
    "totalCredits" BIGINT NOT NULL,
    "generationQuoteId" UUID NOT NULL,

    CONSTRAINT "WorkflowRunQuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workflowId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "workflowSnapshot" JSONB NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "succeededCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL,
    "cancelledCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "retryOfRunId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRunItem" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "rowKey" TEXT NOT NULL,
    "columnKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "generationJobId" UUID NOT NULL,

    CONSTRAINT "WorkflowRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workflow_userId_archivedAt_updatedAt_idx" ON "Workflow"("userId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRow_workflowId_rowKey_key" ON "WorkflowRow"("workflowId", "rowKey");

-- CreateIndex
CREATE INDEX "WorkflowRow_workflowId_sortOrder_idx" ON "WorkflowRow"("workflowId", "sortOrder");

-- CreateIndex
CREATE INDEX "WorkflowRunQuote_userId_createdAt_idx" ON "WorkflowRunQuote"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRunQuote_workflowId_createdAt_idx" ON "WorkflowRunQuote"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRunQuote_expiresAt_idx" ON "WorkflowRunQuote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunQuoteItem_quoteId_rowKey_columnKey_key" ON "WorkflowRunQuoteItem"("quoteId", "rowKey", "columnKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunQuoteItem_generationQuoteId_key" ON "WorkflowRunQuoteItem"("generationQuoteId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_userId_idempotencyKey_key" ON "WorkflowRun"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowRun_userId_createdAt_idx" ON "WorkflowRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_createdAt_idx" ON "WorkflowRun"("workflowId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunItem_runId_rowKey_columnKey_key" ON "WorkflowRunItem"("runId", "rowKey", "columnKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunItem_generationJobId_key" ON "WorkflowRunItem"("generationJobId");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRow" ADD CONSTRAINT "WorkflowRow_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunQuote" ADD CONSTRAINT "WorkflowRunQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunQuote" ADD CONSTRAINT "WorkflowRunQuote_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunQuoteItem" ADD CONSTRAINT "WorkflowRunQuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "WorkflowRunQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunQuoteItem" ADD CONSTRAINT "WorkflowRunQuoteItem_generationQuoteId_fkey" FOREIGN KEY ("generationQuoteId") REFERENCES "GenerationQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunItem" ADD CONSTRAINT "WorkflowRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRunItem" ADD CONSTRAINT "WorkflowRunItem_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Workflow and batch invariants, enforced even outside application code.
ALTER TABLE "Workflow" ADD CONSTRAINT "workflow_version_positive" CHECK ("version" >= 1);
ALTER TABLE "WorkflowRow" ADD CONSTRAINT "workflow_row_order_non_negative" CHECK ("sortOrder" >= 0);
ALTER TABLE "WorkflowRunQuote" ADD CONSTRAINT "workflow_run_quote_positive" CHECK ("workflowVersion" >= 1 AND "totalCredits" >= 0);
ALTER TABLE "WorkflowRunQuoteItem" ADD CONSTRAINT "workflow_run_quote_item_positive" CHECK ("unitCredits" > 0 AND "totalCredits" >= "unitCredits");
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "workflow_run_counts_non_negative" CHECK ("totalCount" >= 0 AND "succeededCount" >= 0 AND "failedCount" >= 0 AND "cancelledCount" >= 0);

COMMIT;
