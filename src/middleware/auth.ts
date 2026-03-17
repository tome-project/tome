import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { sendError } from '../utils';

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Middleware that requires a valid Supabase JWT
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Missing or invalid authorization header', 401);
    return;
  }

  const token = authHeader.slice(7);

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    sendError(res, 'Invalid or expired token', 401);
    return;
  }

  req.userId = data.user.id;
  next();
}
