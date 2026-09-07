import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  request_id?: string | string[];
}

export const sendSuccess = <T>(res: Response, data: T, statusCode = 200, requestId?: string | string[]) => {
  const response: ApiResponse<T> = {
    success: true,
    data,
    request_id: requestId,
  };
  return res.status(statusCode).json(response);
};

export const sendError = (
  res: Response,
  message: string,
  code = 'INTERNAL_ERROR',
  statusCode = 500,
  requestId?: string | string[]
) => {
  const response: ApiResponse = {
    success: false,
    error: {
      code,
      message,
    },
    request_id: requestId,
  };
  return res.status(statusCode).json(response);
};
