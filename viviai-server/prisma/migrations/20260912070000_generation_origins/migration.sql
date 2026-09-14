BEGIN;

-- AlterTable
ALTER TABLE "GenerationQuote"
  ADD COLUMN "originType" TEXT,
  ADD COLUMN "originId" TEXT,
  ADD COLUMN "originVersion" INTEGER,
  ADD COLUMN "originSnapshot" JSONB;

ALTER TABLE "GenerationJob"
  ADD COLUMN "originType" TEXT,
  ADD COLUMN "originId" TEXT,
  ADD COLUMN "originVersion" INTEGER,
  ADD COLUMN "originSnapshot" JSONB;

ALTER TABLE "GenerationQuote" ADD CONSTRAINT "quote_origin_complete" CHECK (
  ("originType" IS NULL AND "originId" IS NULL AND "originVersion" IS NULL AND "originSnapshot" IS NULL)
  OR
  ("originType" IN ('tool', 'workflow') AND "originId" IS NOT NULL AND "originVersion" IS NOT NULL AND "originSnapshot" IS NOT NULL)
);

ALTER TABLE "GenerationJob" ADD CONSTRAINT "job_origin_complete" CHECK (
  ("originType" IS NULL AND "originId" IS NULL AND "originVersion" IS NULL AND "originSnapshot" IS NULL)
  OR
  ("originType" IN ('tool', 'workflow') AND "originId" IS NOT NULL AND "originVersion" IS NOT NULL AND "originSnapshot" IS NOT NULL)
);

COMMIT;
