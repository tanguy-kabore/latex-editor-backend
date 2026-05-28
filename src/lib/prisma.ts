import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

// In dev the pgbouncer pooler (DATABASE_URL) returns "Tenant or user not found".
// DIRECT_URL bypasses the pooler and connects straight to Postgres.
const datasourceUrl =
  process.env.NODE_ENV !== 'production'
    ? (process.env.DIRECT_URL ?? process.env.DATABASE_URL)
    : process.env.DATABASE_URL

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'],
    datasourceUrl,
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
