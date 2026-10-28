-- CreateTable
CREATE TABLE "VehicleSessionHistory" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "macId" TEXT,
    "sessionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "stopCause" TEXT,
    "reportSizeBytes" INTEGER,
    "reportUploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleSessionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleSessionHistory_sessionId_key" ON "VehicleSessionHistory"("sessionId");

-- CreateIndex
CREATE INDEX "VehicleSessionHistory_vin_idx" ON "VehicleSessionHistory"("vin");

-- CreateIndex
CREATE INDEX "VehicleSessionHistory_endedAt_idx" ON "VehicleSessionHistory"("endedAt");
