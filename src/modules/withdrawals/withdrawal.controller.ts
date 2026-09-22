import { Request, Response, NextFunction } from 'express';
import { WithdrawalService } from './withdrawal.service';
import { sendSuccess } from '../../utils/apiResponse';

export class WithdrawalController {
  static async requestWithdrawal(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const idempotencyKey = (req as any).idempotencyKey;
      const { amount, bankDetails, fromAddress, referenceId, windowMinutes } = req.body;

      const result = await WithdrawalService.createWithdrawalRequest({
        clientId,
        idempotencyKey,
        amount,
        bankDetails,
        fromAddress,
        referenceId,
        windowMinutes: windowMinutes !== undefined ? Number(windowMinutes) : undefined,
      });

      sendSuccess(res, result, 202, req.header('x-request-id') as string | undefined);
    } catch (error) {
      next(error);
    }
  }

  static async approveWithdrawal(req: Request, res: Response, next: NextFunction) {
    try {
      // In a real system, this would be an admin endpoint or require strong internal auth
      const { id } = req.params;
      
      const result = await WithdrawalService.approveWithdrawal(id as string);
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  }

  static async getWithdrawalStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const clientId = (req as any).client.id;

      const status = await WithdrawalService.getWithdrawalStatus(id as string, clientId);
      sendSuccess(res, status);
    } catch (error) {
      next(error);
    }
  }

  static async submitPayoutProof(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const { payoutReference, notes } = req.body || {};
      sendSuccess(res, await WithdrawalService.submitPayoutProof(req.params.id as string, clientId, { payoutReference, notes }));
    } catch (error) {
      next(error);
    }
  }

  static async requestExtension(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      sendSuccess(res, await WithdrawalService.requestExtension(req.params.id as string, clientId, req.body?.reason));
    } catch (error) {
      next(error);
    }
  }
}
