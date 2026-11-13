import { Request, Response, NextFunction } from 'express';
import { DepositService } from './deposit.service';
import { sendSuccess } from '../../utils/apiResponse';

export class DepositController {
  static async registerDepositMock(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const { amount, currency, referenceId, proof } = req.body;
      
      const result = await DepositService.registerMockDeposit({
        clientId,
        amount,
        currency,
        referenceId,
        proof,
      });

      sendSuccess(res, result, 201);
    } catch (error) {
      next(error);
    }
  }
}
