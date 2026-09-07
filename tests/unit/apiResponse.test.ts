import { Response } from 'express';
import { sendSuccess, sendError } from '../../src/utils/apiResponse';

function createMockResponse() {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe('apiResponse helpers', () => {
  it('sendSuccess defaults to status 200 and wraps data', () => {
    const res = createMockResponse();
    sendSuccess(res, { foo: 'bar' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { foo: 'bar' },
      request_id: undefined,
    });
  });

  it('sendSuccess honors a custom status code and request id', () => {
    const res = createMockResponse();
    sendSuccess(res, { id: 1 }, 202, 'req-123');

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { id: 1 },
      request_id: 'req-123',
    });
  });

  it('sendError defaults to 500 / INTERNAL_ERROR', () => {
    const res = createMockResponse();
    sendError(res, 'Something broke');

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something broke' },
      request_id: undefined,
    });
  });

  it('sendError honors a custom code, status and request id', () => {
    const res = createMockResponse();
    sendError(res, 'Not found', 'NOT_FOUND', 404, 'req-456');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
      request_id: 'req-456',
    });
  });
});
