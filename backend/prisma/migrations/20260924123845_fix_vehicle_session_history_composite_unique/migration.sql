-- DropIndex
DROP INDEX "VehicleSessionHistory_sessionId_key";

-- CreateIndex
CREATE UNIQUE INDEX "VehicleSessionHistory_vin_macId_sessionId_key" ON "VehicleSessionHistory"("vin", "macId", "sessionId");
