import mongoose from 'mongoose';
import { env } from './env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI);
    log.info({ env: env.NODE_ENV }, 'Connected to MongoDB');
  } catch (error) {
    log.error({ err: error }, 'Connection failed');
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    log.error({ err }, 'Runtime error');
  });

  mongoose.connection.on('disconnected', () => {
    log.warn('Disconnected');
  });
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
