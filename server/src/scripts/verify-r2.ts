// ═══════════════════════════════════════════════════════════
// verify-r2 — smoke-tests the R2 connection end to end.
//
//   npx tsx src/scripts/verify-r2.ts   (run from the server/ dir)
//
// Does a full round-trip (put → exists → get → list → delete) on a
// throwaway healthcheck object, so a green run proves credentials,
// bucket, and Object Read & Write permissions are all correct.
// ═══════════════════════════════════════════════════════════

import { r2Enabled, env } from '../config/env.js';
import {
  isStorageEnabled,
  putObject,
  getObject,
  objectExists,
  listObjects,
  deleteObject,
} from '../services/storage/storage.service.js';

async function main(): Promise<void> {
  console.log('── R2 connection check ─────────────────────────');
  console.log(`  account id : ${env.R2_ACCOUNT_ID ? env.R2_ACCOUNT_ID.slice(0, 6) + '…' : '(missing)'}`);
  console.log(`  bucket     : ${env.R2_BUCKET ?? '(missing)'}`);
  console.log(`  enabled    : ${r2Enabled}`);
  if (!isStorageEnabled()) {
    console.error('\n❌ R2 is not fully configured — set all four R2_* vars.');
    process.exit(1);
  }

  const key = 'healthcheck/verify-r2.txt';
  const payload = Buffer.from(`ok ${new Date().toISOString()}`, 'utf8');

  try {
    process.stdout.write('  put …    ');
    await putObject(key, payload, 'text/plain');
    console.log('✓');

    process.stdout.write('  exists … ');
    const exists = await objectExists(key);
    console.log(exists ? '✓' : '✗');
    if (!exists) throw new Error('object not found right after put');

    process.stdout.write('  get …    ');
    const got = await getObject(key);
    const match = got?.data.equals(payload);
    console.log(match ? '✓' : '✗');
    if (!match) throw new Error('fetched bytes differ from what was put');

    process.stdout.write('  list …   ');
    const listed = await listObjects('healthcheck/');
    console.log(`✓ (${listed.length} object(s) under healthcheck/)`);

    process.stdout.write('  delete … ');
    await deleteObject(key);
    const stillThere = await objectExists(key);
    console.log(!stillThere ? '✓' : '✗');
    if (stillThere) throw new Error('object still present after delete');

    console.log('\n✅ R2 is working — credentials, bucket and permissions all good.');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ R2 check failed: ${(err as Error).message}`);
    console.error('   Likely causes: wrong account id / keys, bucket name mismatch,');
    console.error('   or the API token lacks Object Read & Write on this bucket.');
    process.exit(1);
  }
}

void main();
