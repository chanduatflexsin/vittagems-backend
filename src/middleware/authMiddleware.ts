import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import crypto from 'crypto';
import { env } from '../config/env';
import { AuditService } from '../modules/audit/audit.service';

const prisma = new PrismaClient();

// In a real system, you would cache this in Redis to avoid DB hits on every request
export const authenticateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header. Expected format: Bearer <api_key>');
    }

    const apiKey = authHeader.split(' ')[1];

    // Hash the provided API key to compare with the DB
    const keyHash = crypto
      .createHmac('sha256', env.API_KEY_SECRET)
      .update(apiKey)
      .digest('hex');

    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        client: true,
        Permissions: true,
      },
    });

    if (!keyRecord || !keyRecord.isActive) {
      throw new UnauthorizedError('Invalid or revoked API key');
    }

    if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
      throw new UnauthorizedError('API key has expired');
    }

    if (!keyRecord.client.isActive) {
      throw new ForbiddenError('Client account is suspended');
    }

    // Attach to request
    (req as any).client = keyRecord.client;
    (req as any).apiKey = keyRecord;
    (req as any).permissions = keyRecord.Permissions.map((p) => p.scope);

    // Update last used asynchronously (don't await to avoid blocking)
    prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    }).catch((err) => console.error('Failed to update API key lastUsedAt:', err));
    
    // Asynchronously log the access
    AuditService.log(keyRecord.client.id, 'API_ACCESS', { path: req.path, method: req.method }).catch();

    next();
  } catch (error) {
    next(error);
  }
};

export const requirePermissions = (requiredScopes: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientPermissions = (req as any).permissions as string[];

      if (!clientPermissions) {
        throw new ForbiddenError('No permissions loaded');
      }

      const hasAllRequired = requiredScopes.every((scope) => clientPermissions.includes(scope));

      if (!hasAllRequired) {
        throw new ForbiddenError(`Missing required scopes: ${requiredScopes.join(', ')}`);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const requireBlockchainAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;

    const account = await prisma.blockchainAccount.findFirst({
      where: { clientId, isActive: true },
    });

    if (!account) {
      throw new ForbiddenError('Client does not have an active registered blockchain account', 'BLOCKCHAIN_ACCESS_DENIED');
    }

    (req as any).blockchainAccount = account;
    next();
  } catch (error) {
    next(error);
  }
};
