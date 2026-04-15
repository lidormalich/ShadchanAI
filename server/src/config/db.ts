import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log(`[DB] Connected to MongoDB (${env.NODE_ENV})`);
  } catch (error) {
    console.error('[DB] Connection failed:', error);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    console.error('[DB] Runtime error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[DB] Disconnected');
  });
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
