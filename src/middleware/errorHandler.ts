import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { sendError } from '../utils/apiResponse';
import { ZodError } from 'zod';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    logger.error(`${err.code}: ${err.message}`);
    return sendError(res, err.message, err.code, err.statusCode);
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
    logger.warn(`Validation Error: ${message}`);
    return sendError(res, `Validation failed: ${message}`, 'VALIDATION_ERROR', 400);
  }

  // Handle unexpected errors
  logger.error(`Unexpected Error: ${err.message}`, { stack: err.stack });
  return sendError(res, 'Internal server error', 'INTERNAL_ERROR', 500);
};
