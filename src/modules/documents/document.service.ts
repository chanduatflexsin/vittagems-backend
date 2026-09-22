import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { NotFoundError, ValidationError } from '../../utils/errors';

const prisma = new PrismaClient();

/**
 * Supporting evidence for a settlement: a bank statement, payment receipt or
 * screenshot that DAO members read alongside the bank reference.
 *
 * Files are written under PROOF_STORAGE_DIR under a generated key, never under
 * the name the client supplied, so an uploaded name can never escape the
 * directory or overwrite anything. The original name is kept only as metadata.
 */

export const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv']);

export class DocumentService {
  static get maxBytes() {
    return env.PROOF_MAX_MB * 1024 * 1024;
  }

  static async storageDir() {
    const dir = path.resolve(env.PROOF_STORAGE_DIR);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  static async save(args: {
    clientId: string;
    proposalId?: string | null;
    kind: 'DEPOSIT_PROOF' | 'PAYOUT_PROOF';
    filename: string;
    mimeType: string;
    body: Buffer;
    uploadedBy: string;
  }) {
    const mimeType = (args.mimeType || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES[mimeType]) {
      throw new ValidationError(
        `Unsupported file type "${mimeType || 'unknown'}". Allowed: images (png, jpg, gif, webp, heic), PDF, text/CSV, Word and Excel documents.`,
      );
    }
    if (!args.body?.length) throw new ValidationError('The uploaded file is empty');
    if (args.body.length > this.maxBytes) {
      throw new ValidationError(`File is larger than the ${env.PROOF_MAX_MB} MB limit`);
    }

    const sha256 = crypto.createHash('sha256').update(args.body).digest('hex');
    const storageKey = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ALLOWED_TYPES[mimeType]}`;
    const dir = await this.storageDir();
    await fs.writeFile(path.join(dir, storageKey), args.body);

    // Keep the client's name for display only, stripped of any path.
    const filename = path.basename(args.filename || 'upload').slice(0, 180) || 'upload';

    const doc = await prisma.proofDocument.create({
      data: {
        clientId: args.clientId,
        proposalId: args.proposalId ?? null,
        kind: args.kind,
        filename,
        mimeType,
        sizeBytes: args.body.length,
        sha256,
        storageKey,
        uploadedBy: args.uploadedBy,
      },
    });
    logger.info(`Proof document ${doc.id} (${filename}, ${args.body.length} bytes) stored for proposal ${args.proposalId}`);
    return this.serialize(doc);
  }

  static serialize(d: {
    id: string; kind: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; uploadedBy: string; createdAt: Date;
  }) {
    return {
      documentId: d.id,
      kind: d.kind,
      filename: d.filename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      viewable: VIEWABLE.has(d.mimeType),
      uploadedBy: d.uploadedBy,
      createdAt: d.createdAt,
    };
  }

  static async listForProposal(proposalId: string) {
    const rows = await prisma.proofDocument.findMany({ where: { proposalId }, orderBy: { createdAt: 'asc' } });
    return rows.map(this.serialize);
  }

  /** Read a document back. `clientId` restricts a client to its own uploads; DAO members pass none. */
  static async read(documentId: string, clientId?: string) {
    const doc = await prisma.proofDocument.findUnique({ where: { id: documentId } });
    if (!doc || (clientId && doc.clientId !== clientId)) throw new NotFoundError('Document not found');

    const dir = await this.storageDir();
    const file = path.join(dir, path.basename(doc.storageKey));
    try {
      return { doc, body: await fs.readFile(file) };
    } catch {
      throw new NotFoundError('The stored file for this document is missing');
    }
  }
}
