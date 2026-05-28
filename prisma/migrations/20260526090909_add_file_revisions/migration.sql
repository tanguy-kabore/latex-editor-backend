-- CreateTable
CREATE TABLE "FileRevision" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileRevision_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
