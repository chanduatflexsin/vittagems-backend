import { Request, Response, NextFunction } from 'express';
import { MintService } from './mint.service';
import { sendSuccess } from '../../utils/apiResponse';

export class MintController {
  static async mintTokens(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const idempotencyKey = (req as any).idempotencyKey;
      const { amount, referenceId, toAddress, corridor } = req.body;

      const result = await MintService.processMintRequest({
        clientId,
        idempotencyKey,
        amount,
        referenceId,
        toAddress,
        corridor,
      });

      sendSuccess(res, result, 202, req.header('x-request-id') as string);
    } catch (error) {
      next(error);
    }
  }

  static async getMintStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const clientId = (req as any).client.id;

      const status = await MintService.getMintStatus(id as string, clientId);
      sendSuccess(res, status);
    } catch (error) {
      next(error);
    }
  }
}
