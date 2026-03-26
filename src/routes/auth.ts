import { Router, Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../services/supabase';
import { sendSuccess, sendError } from '../utils';

export const authRouter = Router();

// POST /api/v1/auth/register
authRouter.post('/api/v1/auth/register', async (req: Request, res: Response) => {
  const { email, password, display_name } = req.body;

  if (!email || !password) {
    sendError(res, 'Email and password are required');
    return;
  }

  // Use admin API to create user (auto-confirms email)
  const { data: adminData, error: adminError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: display_name || email.split('@')[0] },
  });

  if (adminError) {
    sendError(res, adminError.message);
    return;
  }

  // Sign in immediately to get a session token
  const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  sendSuccess(res, {
    user: {
      id: adminData.user?.id,
      email: adminData.user?.email,
      display_name: adminData.user?.user_metadata?.display_name,
    },
    session: loginError ? null : loginData.session,
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
