import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { prismaMock } from '../setup';
import { DocumentService } from '../../src/modules/documents/document.service';
import { env } from '../../src/config/env';

const tmpDir = path.join(os.tmpdir(), `vg-proofs-${process.pid}`);
const original = env.PROOF_STORAGE_DIR;

beforeAll(() => { (env as any).PROOF_STORAGE_DIR = tmpDir; });
afterAll(async () => {
  (env as any).PROOF_STORAGE_DIR = original;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const upload = (over: Record<string, any> = {}) => ({
  clientId: 'c1',
  proposalId: 'p1',
  kind: 'DEPOSIT_PROOF' as const,
  filename: 'statement.pdf',
  mimeType: 'application/pdf',
  body: Buffer.from('%PDF-1.4 fake statement'),
  uploadedBy: 'XPZ Corp',
  ...over,
});

describe('DocumentService.save - validation', () => {
  it('refuses a file type that is not allowed', async () => {
    await expect(DocumentService.save(upload({ mimeType: 'application/x-msdownload' }))).rejects.toThrow(
      /Unsupported file type/,
    );
  });

  it('refuses an empty file', async () => {
    await expect(DocumentService.save(upload({ body: Buffer.alloc(0) }))).rejects.toThrow(/empty/);
  });

  it('refuses a file over the size limit', async () => {
    const tooBig = Buffer.alloc(DocumentService.maxBytes + 1);
    await expect(DocumentService.save(upload({ body: tooBig }))).rejects.toThrow(/larger than the/);
  });

  it('accepts a content type that carries parameters', async () => {
    prismaMock.proofDocument.create.mockImplementation((({ data }: any) => ({ ...data, id: 'd1', createdAt: new Date() })) as any);
    const doc = await DocumentService.save(upload({ mimeType: 'text/csv; charset=utf-8', filename: 'rows.csv' }));
    expect(doc.mimeType).toBe('text/csv');
  });
});

describe('DocumentService.save - storage', () => {
  it('writes the bytes, hashes them, and never uses the supplied name as the path', async () => {
    prismaMock.proofDocument.create.mockImplementation((({ data }: any) => ({ ...data, id: 'd1', createdAt: new Date() })) as any);

    const doc = await DocumentService.save(upload({ filename: '../../escape.pdf' }));

    const args = prismaMock.proofDocument.create.mock.calls[0][0].data as any;
    expect(args.storageKey).not.toContain('..');
    expect(args.storageKey).toMatch(/^\d+-[0-9a-f]{16}\.pdf$/);
    expect(doc.filename).toBe('escape.pdf'); // path stripped, name kept for display
    expect(doc.sha256).toHaveLength(64);
    expect(doc.viewable).toBe(true);

    const written = await fs.readFile(path.join(tmpDir, args.storageKey));
    expect(written.toString()).toBe('%PDF-1.4 fake statement');
  });

  it('marks a Word document as not inline-viewable', async () => {
    prismaMock.proofDocument.create.mockImplementation((({ data }: any) => ({ ...data, id: 'd2', createdAt: new Date() })) as any);
    const doc = await DocumentService.save(
      upload({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'note.docx' }),
    );
    expect(doc.viewable).toBe(false);
  });
});

describe('DocumentService.read', () => {
  it('returns the stored bytes', async () => {
    prismaMock.proofDocument.create.mockImplementation((({ data }: any) => ({ ...data, id: 'd3', createdAt: new Date() })) as any);
    await DocumentService.save(upload({ body: Buffer.from('receipt bytes'), mimeType: 'image/png', filename: 'r.png' }));
    const stored = prismaMock.proofDocument.create.mock.calls[0][0].data as any;

    prismaMock.proofDocument.findUnique.mockResolvedValue({ ...stored, id: 'd3' } as any);
    const { body } = await DocumentService.read('d3');
    expect(body.toString()).toBe('receipt bytes');
  });

  it('hides another client\'s document', async () => {
    prismaMock.proofDocument.findUnique.mockResolvedValue({ id: 'd4', clientId: 'someone-else' } as any);
    await expect(DocumentService.read('d4', 'c1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports a missing file rather than throwing a raw fs error', async () => {
    prismaMock.proofDocument.findUnique.mockResolvedValue({ id: 'd5', clientId: 'c1', storageKey: 'gone.pdf' } as any);
    await expect(DocumentService.read('d5', 'c1')).rejects.toThrow(/stored file for this document is missing/);
  });
});
