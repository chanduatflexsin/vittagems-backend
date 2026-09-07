import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InternalServerError,
} from '../../src/utils/errors';

describe('Error classes', () => {
  it('AppError sets message, statusCode, code and isOperational', () => {
    const err = new AppError('boom', 418, 'TEAPOT');
    expect(err.message).toBe('boom');
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('TEAPOT');
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('AppError respects an explicit isOperational=false', () => {
    const err = new AppError('boom', 500, 'X', false);
    expect(err.isOperational).toBe(false);
  });

  it.each([
    [UnauthorizedError, 401, 'UNAUTHORIZED', 'Unauthorized access'],
    [ForbiddenError, 403, 'ACCESS_DENIED', 'Access denied'],
    [ValidationError, 400, 'VALIDATION_ERROR', 'Validation failed'],
    [NotFoundError, 404, 'NOT_FOUND', 'Resource not found'],
    [ConflictError, 409, 'CONFLICT', 'Resource conflict'],
  ])('%p defaults to statusCode %i, code %s, message %s', (ErrorClass: any, statusCode, code, message) => {
    const err = new ErrorClass();
    expect(err.statusCode).toBe(statusCode);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err).toBeInstanceOf(AppError);
  });

  it('allows overriding message and code on subclasses', () => {
    const err = new NotFoundError('Deposit missing', 'DEPOSIT_NOT_FOUND');
    expect(err.message).toBe('Deposit missing');
    expect(err.code).toBe('DEPOSIT_NOT_FOUND');
    expect(err.statusCode).toBe(404);
  });

  it('InternalServerError is non-operational by default', () => {
    const err = new InternalServerError();
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(false);
  });
});
