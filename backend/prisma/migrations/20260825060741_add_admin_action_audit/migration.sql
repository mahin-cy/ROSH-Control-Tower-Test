-- CreateTable
CREATE TABLE "AdminActionAudit" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminActionAudit_vin_idx" ON "AdminActionAudit"("vin");

-- CreateIndex
CREATE INDEX "AdminActionAudit_issuedAt_idx" ON "AdminActionAudit"("issuedAt");
