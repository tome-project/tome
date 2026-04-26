import { Router, Request, Response } from 'express';
import { sendSuccess, sendError } from '../utils';
import {
  createUser,
  ensureUserProfile,
  findUserByEmail,
  findUserById,
  issueSession,
  verifyPassword,
  verifyRefreshToken,
} from '../services/auth';

export const authRouter = Router();

// POST /api/v1/auth/register — create a new user, auto-confirmed, return a
// fresh session. Mirrors the old Supabase-backed shape so the Flutter
// client doesn't need to change.
authRouter.post('/api/v1/auth/register', async (req: Request, res: Response) => {
  const { email, password, display_name } = req.body ?? {};
  if (!email || !password) {
    sendError(res, 'Email and password are required');
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    sendError(res, 'Password must be at least 6 characters');
    return;
  }

  try {
    const existing = await findUserByEmail(String(email).toLowerCase());
    if (existing) {
      sendError(res, 'Email is already registered', 409);
      return;
    }
    const user = await createUser({
      email: String(email).toLowerCase(),
      password: String(password),
      display_name,
    });
    await ensureUserProfile(user);
    const session = issueSession(user);
    sendSuccess(
      res,
      {
        user: { id: user.id, email: user.email, display_name: user.display_name },
        session,
      },
      201
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    sendError(res, message, 500);
  }
});

// POST /api/v1/auth/login — verify password, return a session.
authRouter.post('/api/v1/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    sendError(res, 'Email and password are required');
    return;
  }
  try {
    const user = await findUserByEmail(String(email).toLowerCase());
    if (!user) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }
    const ok = await verifyPassword(String(password), user.password_hash);
    if (!ok) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }
    const session = issueSession(user);
    sendSuccess(res, {
      user: { id: user.id, email: user.email, display_name: user.display_name },
      session,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    sendError(res, message, 500);
  }
});

// POST /api/v1/auth/refresh — exchange a refresh token for a fresh session.
// The client calls this on cold start when the stored access token has expired.
authRouter.post('/api/v1/auth/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body ?? {};
  if (!refresh_token || typeof refresh_token !== 'string') {
    sendError(res, 'refresh_token is required');
    return;
  }
  try {
    const { sub } = verifyRefreshToken(refresh_token);
    const user = await findUserById(sub);
    if (!user) {
      sendError(res, 'User no longer exists', 401);
      return;
    }
    const session = issueSession(user);
    sendSuccess(res, {
      user: { id: user.id, email: user.email, display_name: user.display_name },
      session,
    });
  } catch {
    sendError(res, 'Session expired', 401);
  }
});
