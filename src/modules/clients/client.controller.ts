import { Request, Response, NextFunction } from 'express';
import { ClientService } from './client.service';
import { sendSuccess } from '../../utils/apiResponse';

export class ClientController {
  static async registerClient(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, permissions, blockchainAddress } = req.body;
      const result = await ClientService.registerClient(name, permissions, blockchainAddress);
      sendSuccess(res, result, 201);
    } catch (error) {
      next(error);
    }
  }

  static async getClientDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const result = await ClientService.getClientDetails(clientId);
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  }
}
