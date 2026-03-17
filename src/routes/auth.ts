import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const authRouter = Router();

// POST /api/v1/auth/register
authRouter.post('/api/v1/auth/register', async (req: Request, res: Response) => {
  const { email, password, display_name } = req.body;

  if (!email || !password) {
    sendError(res, 'Email and password are required');
    return;
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: display_name || email.split('@')[0] },
    },
  });

  if (error) {
    sendError(res, error.message);
    return;
  }

  sendSuccess(res, {
    user: {
      id: data.user?.id,
      email: data.user?.email,
      display_name: data.user?.user_metadata?.display_name,
    },
    session: data.session,
  }, 201);
});

// POST /api/v1/auth/login
authRouter.post('/api/v1/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    sendError(res, 'Email and password are required');
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    sendError(res, error.message, 401);
    return;
  }

  sendSuccess(res, {
    user: {
      id: data.user.id,
      email: data.user.email,
      display_name: data.user.user_metadata?.display_name,
    },
    session: data.session,
  });
});
