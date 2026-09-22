import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class AuditService {
  static async log(clientId: string | null, action: string, details: any = {}) {
    try {
      await prisma.auditLog.create({
        data: {
          clientId,
          action,
          details
        }
      });
    } catch (error) {
      console.error('Failed to write audit log', error);
      // We explicitly swallow this error so a failed audit log doesn't block the main financial transaction
    }
  }
}
