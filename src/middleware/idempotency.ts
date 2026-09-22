import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { ValidationError } from '../utils/errors';

const prisma = new PrismaClient();

/**
 * Middleware to check for Idempotency-Key header.
 * Real implementations usually cache this in Redis to lock concurrent requests,
 * and then store the final response to return for future duplicate requests.
 * Here we do a simplified check against the DB transactions to prevent duplicate processing.
 */
export const requireIdempotency = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key');

    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required for this operation');
    }

    if (idempotencyKey.length < 10) {
      throw new ValidationError('Idempotency-Key must be at least 10 characters long');
    }

    // Check if a transaction with this key already exists
    const existingTx = await prisma.transaction.findUnique({
      where: { idempotencyKey },
    });

    if (existingTx) {
      // In a fully featured system, you would return the cached HTTP response here.
      // For this implementation, we simply return the existing transaction.
      return res.status(200).json({
        success: true,
        message: 'Duplicate request detected. Returning existing transaction.',
        data: existingTx,
      });
    }

    // Pass the key to the route handler
    (req as any).idempotencyKey = idempotencyKey;
    next();
  } catch (error) {
    next(error);
  }
};
