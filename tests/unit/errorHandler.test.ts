import { Response } from 'express';
import { z, ZodError } from 'zod';
import { errorHandler } from '../../src/middleware/errorHandler';
import { ValidationError, NotFoundError } from '../../src/utils/errors';

function createMockResponse() {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe('errorHandler middleware', () => {
  const req: any = {};
  const next = jest.fn();

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('formats AppError subclasses using their statusCode/code/message', () => {
    const res = createMockResponse();
    const err = new NotFoundError('Deposit not found', 'DEPOSIT_NOT_FOUND');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'DEPOSIT_NOT_FOUND', message: 'Deposit not found' },
      request_id: undefined,
    });
  });

  it('formats ValidationError (400) correctly', () => {
    const res = createMockResponse();
    const err = new ValidationError('amount is required');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amount is required' } })
    );
  });

  it('formats ZodError as a 400 VALIDATION_ERROR with combined issue messages', () => {
    const res = createMockResponse();
    const schema = z.object({ amount: z.string() });
    let zodError: ZodError;
    try {
      schema.parse({});
    } catch (e) {
      zodError = e as ZodError;
    }

    errorHandler(zodError!, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const call = (res.json as jest.Mock).mock.calls[0][0];
    expect(call.success).toBe(false);
    expect(call.error.code).toBe('VALIDATION_ERROR');
    expect(call.error.message).toContain('amount');
  });

  it('falls back to 500 INTERNAL_ERROR for unrecognized errors and hides the raw message', () => {
    const res = createMockResponse();
    const err = new Error('some internal detail leaked from a dependency');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      request_id: undefined,
    });
  });
});
