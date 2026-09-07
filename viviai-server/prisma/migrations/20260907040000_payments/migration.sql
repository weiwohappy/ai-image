CREATE TABLE "PaymentOrder" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "orderNo" TEXT NOT NULL UNIQUE,
 "planId" TEXT NOT NULL, "name" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
 "currency" TEXT NOT NULL DEFAULT 'CNY' CHECK ("currency" = 'CNY'),
 "credits" INTEGER NOT NULL CHECK ("credits" > 0), "durationDays" INTEGER NOT NULL CHECK ("durationDays" BETWEEN 1 AND 366),
 "channel" TEXT NOT NULL CHECK ("channel" IN ('wechat', 'alipay')), "merchantId" TEXT NOT NULL, "appId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'creating' CHECK ("status" IN ('creating', 'pending', 'paid')),
 "checkout" JSONB, "tradeNo" TEXT, "paidAt" TIMESTAMPTZ(6), "fulfilledAt" TIMESTAMPTZ(6),
 "expiresAt" TIMESTAMPTZ(6) NOT NULL, "nextSyncAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "syncLeaseUntil" TIMESTAMPTZ(6), "lastError" TEXT,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT "PaymentOrder_paid_state_check" CHECK (("status" = 'paid') = ("tradeNo" IS NOT NULL AND "paidAt" IS NOT NULL AND "fulfilledAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "PaymentOrder_userId_idempotencyKey_key" ON "PaymentOrder"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentOrder_channel_merchantId_tradeNo_key" ON "PaymentOrder"("channel", "merchantId", "tradeNo");
CREATE INDEX "PaymentOrder_status_nextSyncAt_idx" ON "PaymentOrder"("status", "nextSyncAt");
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");
CREATE TABLE "PaymentEvent" (
 "id" UUID PRIMARY KEY, "channel" TEXT NOT NULL, "merchantId" TEXT NOT NULL, "eventId" TEXT NOT NULL,
 "digest" TEXT NOT NULL, "orderId" UUID NOT NULL REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "processedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PaymentEvent_channel_merchantId_eventId_key" ON "PaymentEvent"("channel", "merchantId", "eventId");
ALTER TABLE "CreditLot" ADD COLUMN "paymentOrderId" UUID;
CREATE UNIQUE INDEX "CreditLot_paymentOrderId_key" ON "CreditLot"("paymentOrderId");
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_paymentOrderId_fkey" FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_revenue_nonnegative" CHECK ("revenueMinor" >= 0);
