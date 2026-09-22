import { Request, Response, NextFunction } from 'express';
import { TransferService } from './transfer.service';
import { sendSuccess } from '../../utils/apiResponse';

export class TransferController {
  static async initiateTransfer(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const idempotencyKey = (req as any).idempotencyKey;
      const { amount, fromAddress, toAddress, referenceId } = req.body;

      const result = await TransferService.processTransferRequest({
        clientId,
        idempotencyKey,
        amount,
        fromAddress,
        toAddress,
        referenceId,
      });

      sendSuccess(res, result, 202, req.header('x-request-id') as string);
    } catch (error) {
      next(error);
    }
  }

  static async getTransferStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const clientId = (req as any).client.id;

      const status = await TransferService.getTransferStatus(id as string, clientId);
      sendSuccess(res, status);
    } catch (error) {
      next(error);
    }
  }
}
