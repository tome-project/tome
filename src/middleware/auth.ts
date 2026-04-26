import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils';
import { verifyAccessToken } from '../services/auth';

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/// Middleware that requires a valid Tome-issued JWT in the Authorization
/// header. Sets req.userId on success, returns 401 otherwise.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Missing or invalid authorization header', 401);
    return;
  }
  const token = authHeader.slice(7);
  try {
    const { sub } = verifyAccessToken(token);
    req.userId = sub;
    next();
  } catch {
    sendError(res, 'Invalid or expired token', 401);
  }
}
