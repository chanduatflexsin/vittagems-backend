import { PrismaClient } from '@prisma/client';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';

// A single deep-mocked PrismaClient shared by every module under test.
// Every model/method (client.create, apiKey.findUnique, withdrawal.update, ...)
// is auto-mocked, so new Prisma models don't require updating this file.
export const prismaMock = mockDeep<PrismaClient>() as unknown as DeepMockProxy<PrismaClient>;

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn(() => prismaMock),
  };
});

// Mock BullMQ so no real Redis connection is attempted. Each `new Queue()`
// call gets its own jest.fn()-backed stub; tests import the exported queue
// const from the relevant worker module to assert on `.add`. Each `new
// Worker(name, processor, opts)` stub stashes its processor function as
// `__processor`, and records `.on(event, handler)` registrations under
// `__handlers`, so tests can invoke the job-processing / event logic
// directly -- it would otherwise only ever run inside the real BullMQ
// runtime.
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
    })),
    Worker: jest.fn().mockImplementation((_name: string, processor: (...args: any[]) => any) => {
      const handlers: Record<string, Array<(...args: any[]) => any>> = {};
      return {
        on: jest.fn((event: string, handler: (...args: any[]) => any) => {
          (handlers[event] ||= []).push(handler);
        }),
        __processor: processor,
        __handlers: handlers,
      };
    }),
  };
});

beforeEach(() => {
  mockReset(prismaMock);

  // Several code paths call these fire-and-forget (e.g. `prisma.apiKey.update(...).catch(...)`,
  // AuditService.log's internal `await prisma.auditLog.create(...)`) without awaiting/asserting
  // on them. mockDeep's default return value is `undefined`, and `undefined.catch` throws
  // synchronously, so give these a resolved default. Individual tests can still override.
  prismaMock.apiKey.update.mockResolvedValue({} as any);
  prismaMock.auditLog.create.mockResolvedValue({} as any);
});
