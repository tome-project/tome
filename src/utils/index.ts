import { Response } from 'express';
import { ApiResponse } from '../types';

// Send a standardized success response
export function sendSuccess<T>(res: Response, data: T, status = 200) {
  const response: ApiResponse<T> = { success: true, data };
  res.status(status).json(response);
}

// Send a standardized error response
export function sendError(res: Response, error: string, status = 400) {
  const response: ApiResponse<null> = { success: false, data: null, error };
  res.status(status).json(response);
}
