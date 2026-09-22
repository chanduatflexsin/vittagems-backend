import { Request, Response, NextFunction } from 'express';
import { ProposalService } from './proposal.service';
import { sendSuccess } from '../../utils/apiResponse';

export class ProposalController {
  static async listProposals(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const { state } = req.query as { state?: string };
      sendSuccess(res, await ProposalService.listProposals(clientId, state));
    } catch (error) {
      next(error);
    }
  }

  static async getProposal(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      sendSuccess(res, await ProposalService.getProposal(req.params.id as string, clientId));
    } catch (error) {
      next(error);
    }
  }

  static async executeProposal(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      sendSuccess(res, await ProposalService.execute(req.params.id as string, clientId));
    } catch (error) {
      next(error);
    }
  }
}
