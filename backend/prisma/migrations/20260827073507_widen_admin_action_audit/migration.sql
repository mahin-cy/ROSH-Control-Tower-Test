-- AlterTable
ALTER TABLE "AdminActionAudit" ADD COLUMN     "targetEmail" TEXT,
ALTER COLUMN "vin" DROP NOT NULL;
