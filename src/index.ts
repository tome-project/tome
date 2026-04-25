import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { healthRouter, authRouter, booksRouter, progressRouter, clubsRouter, discussionsRouter, filesRouter, gutenbergRouter, statsRouter, coversRouter, readingSessionsRouter, highlightsRouter, activityRouter, goalsRouter, searchRouter, audiobookshelfRouter, catalogRouter, profilesRouter, friendshipsRouter, userBooksRouter, serversRouter, serverSharesRouter, libraryUploadRouter, invitesRouter } from './routes';
import { errorHandler } from './middleware';

const app = express();
const port = process.env.PORT || 3000;

// We're behind Cloudflare Tunnel / nginx in production, which sets
// X-Forwarded-For. Trust a single upstream hop so express-rate-limit can
// identify clients by real IP without the tunnel warning.
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // 500 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many requests, try again later' },
});
app.use(limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, data: null, error: 'Too many auth attempts, try again later' },
});
app.use('/api/v1/auth', authLimiter);

// Routes
app.use(healthRouter);
app.use(authRouter);
app.use(booksRouter);
app.use(progressRouter);
app.use(clubsRouter);
app.use(discussionsRouter);
app.use(filesRouter);
app.use(gutenbergRouter);
app.use(statsRouter);
app.use(coversRouter);
app.use(readingSessionsRouter);
app.use(highlightsRouter);
app.use(activityRouter);
app.use(goalsRouter);
app.use(searchRouter);
app.use(audiobookshelfRouter);
app.use(catalogRouter);
app.use(profilesRouter);
app.use(friendshipsRouter);
app.use(userBooksRouter);
app.use(serversRouter);
app.use(serverSharesRouter);
app.use(libraryUploadRouter);
app.use(invitesRouter);

// Error handling
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Tome server running on port ${port}`);
});

export default app;
