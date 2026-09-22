import { Request, Response, NextFunction } from 'express';
import { DaoService } from './dao.service';
import { sendSuccess } from '../../utils/apiResponse';

/** DAO endpoints use a member token in X-DAO-Token, never a client API key. */
export const authenticateDaoMember = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    (req as any).daoMember = await DaoService.authenticate(req.header('X-DAO-Token'));
    next();
  } catch (error) {
    next(error);
  }
};

export class DaoController {
  static async registerMember(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await DaoService.registerMember(req.body?.name), 201);
    } catch (error) {
      next(error);
    }
  }

  static async config(_req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await DaoService.config());
    } catch (error) {
      next(error);
    }
  }

  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const m = (req as any).daoMember;
      sendSuccess(res, { memberId: m.id, name: m.name, isActive: m.isActive });
    } catch (error) {
      next(error);
    }
  }

  static async deactivateSelf(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await DaoService.deactivateMember((req as any).daoMember.id));
    } catch (error) {
      next(error);
    }
  }

  static async listProposals(req: Request, res: Response, next: NextFunction) {
    try {
      const { state, type } = req.query as { state?: string; type?: string };
      sendSuccess(res, await DaoService.listProposals((req as any).daoMember.id, { state, type }));
    } catch (error) {
      next(error);
    }
  }

  static async getProposal(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await DaoService.getProposal(req.params.id as string, (req as any).daoMember.id));
    } catch (error) {
      next(error);
    }
  }

  static async vote(req: Request, res: Response, next: NextFunction) {
    try {
      const { decision, comment } = req.body || {};
      sendSuccess(res, await DaoService.castVote(req.params.id as string, (req as any).daoMember, decision, comment));
    } catch (error) {
      next(error);
    }
  }

  static async extend(req: Request, res: Response, next: NextFunction) {
    try {
      const member = (req as any).daoMember;
      await DaoService.extend(req.params.id as string, { actor: member.name, reason: req.body?.reason });
      sendSuccess(res, await DaoService.getProposal(req.params.id as string, member.id));
    } catch (error) {
      next(error);
    }
  }
}
