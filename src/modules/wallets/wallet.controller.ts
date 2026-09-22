import { Request, Response, NextFunction } from 'express';
import { WalletService } from './wallet.service';
import { DocumentService } from '../documents/document.service';
import { DaoService } from '../dao/dao.service';
import { PrismaClient } from '@prisma/client';
import { sendSuccess } from '../../utils/apiResponse';
import { NotFoundError, ValidationError } from '../../utils/errors';

const prisma = new PrismaClient();

const humanSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

export class WalletController {
  static async request(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const { address, label } = req.body || {};
      const wallet = await WalletService.request(clientId, address, label, (req as any).client.name);
      sendSuccess(res, WalletService.serialize(wallet), 201);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await WalletService.listForClient((req as any).client.id));
    } catch (error) {
      next(error);
    }
  }

  static async listForDao(req: Request, res: Response, next: NextFunction) {
    try {
      sendSuccess(res, await WalletService.listForDao((req.query as { status?: string }).status));
    } catch (error) {
      next(error);
    }
  }

  static async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const member = (req as any).daoMember;
      sendSuccess(res, await WalletService.decide(req.params.id as string, 'ACTIVE', member.name));
    } catch (error) {
      next(error);
    }
  }

  static async reject(req: Request, res: Response, next: NextFunction) {
    try {
      const member = (req as any).daoMember;
      sendSuccess(res, await WalletService.decide(req.params.id as string, 'REJECTED', member.name, req.body?.reason));
    } catch (error) {
      next(error);
    }
  }

  static async revoke(req: Request, res: Response, next: NextFunction) {
    try {
      const member = (req as any).daoMember;
      sendSuccess(res, await WalletService.decide(req.params.id as string, 'REVOKED', member.name, req.body?.reason));
    } catch (error) {
      next(error);
    }
  }
}

/**
 * Uploads arrive as the raw request body (Content-Type is the file's own type,
 * X-File-Name carries the name), so no multipart dependency is needed and the
 * bytes are never base64-inflated.
 */
export class DocumentController {
  private static async handleUpload(
    req: Request,
    res: Response,
    kind: 'DEPOSIT_PROOF' | 'PAYOUT_PROOF',
    proposalId: string | null,
    label: string,
  ) {
    const client = (req as any).client;
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      throw new ValidationError('Send the file as the raw request body with its Content-Type header set');
    }

    const doc = await DocumentService.save({
      clientId: client.id,
      proposalId,
      kind,
      filename: (req.header('X-File-Name') || 'upload') as string,
      mimeType: req.header('Content-Type') || '',
      body,
      uploadedBy: client.name,
    });

    if (proposalId) {
      await DaoService.addEvent(
        proposalId,
        'DOCUMENT',
        `${label} attached: ${doc.filename} (${humanSize(doc.sizeBytes)}, sha256 ${doc.sha256.slice(0, 12)}…)`,
        'client',
      );
    }
    sendSuccess(res, doc, 201);
  }

  static async uploadForDeposit(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const deposit = await prisma.deposit.findUnique({ where: { id: req.params.id as string } });
      if (!deposit || deposit.clientId !== clientId) throw new NotFoundError('Deposit not found');
      const proposal = await DaoService.latestForDeposit(deposit.id);
      await DocumentController.handleUpload(req, res, 'DEPOSIT_PROOF', proposal?.id ?? null, 'Deposit proof');
    } catch (error) {
      next(error);
    }
  }

  static async uploadForWithdrawal(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).client.id;
      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: req.params.id as string } });
      if (!withdrawal || withdrawal.clientId !== clientId) throw new NotFoundError('Withdrawal not found');
      const proposal = await DaoService.latestForWithdrawal(withdrawal.id);
      await DocumentController.handleUpload(req, res, 'PAYOUT_PROOF', proposal?.id ?? null, 'Payout proof');
    } catch (error) {
      next(error);
    }
  }

  private static stream(res: Response, doc: { filename: string; mimeType: string }, body: Buffer, viewable: boolean) {
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', body.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${viewable ? 'inline' : 'attachment'}; filename="${doc.filename.replace(/"/g, '')}"`,
    );
    res.send(body);
  }

  /** A client may read back its own uploads. */
  static async downloadAsClient(req: Request, res: Response, next: NextFunction) {
    try {
      const { doc, body } = await DocumentService.read(req.params.id as string, (req as any).client.id);
      DocumentController.stream(res, doc, body, DocumentService.serialize(doc).viewable);
    } catch (error) {
      next(error);
    }
  }

  /** DAO members may read any document, since reviewing them is the job. */
  static async downloadAsDao(req: Request, res: Response, next: NextFunction) {
    try {
      const { doc, body } = await DocumentService.read(req.params.id as string);
      DocumentController.stream(res, doc, body, DocumentService.serialize(doc).viewable);
    } catch (error) {
      next(error);
    }
  }
}
