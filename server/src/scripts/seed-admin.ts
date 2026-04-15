import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { User } from '../modules/users/user.model.js';

const EMAIL = process.env['SEED_EMAIL'] ?? 'admin@demo.local';
const PASSWORD = process.env['SEED_PASSWORD'] ?? 'Admin12345!';
const NAME = process.env['SEED_NAME'] ?? 'Demo Admin';

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const existing = await User.findOne({ email: EMAIL.toLowerCase() });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.name = NAME;
    existing.roles = ['admin'];
    existing.isActive = true;
    await existing.save();
    console.log(`Updated existing user ${EMAIL}`);
  } else {
    await User.create({
      email: EMAIL.toLowerCase(),
      passwordHash,
      name: NAME,
      roles: ['admin'],
      isActive: true,
    });
    console.log(`Created user ${EMAIL}`);
  }
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
