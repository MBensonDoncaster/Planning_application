import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function createDatabase(url: string) {
  // pg supports sslmode=verify-full and sslrootcert in the connection URL.
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
