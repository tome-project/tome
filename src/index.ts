import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { healthRouter, authRouter, libraryRouter, booksRouter, progressRouter, clubsRouter } from './routes';
import { errorHandler } from './middleware';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Routes
app.use(healthRouter);
app.use(authRouter);
app.use(libraryRouter);
app.use(booksRouter);
app.use(progressRouter);
app.use(clubsRouter);

// Error handling
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Tome server running on port ${port}`);
});

export default app;
