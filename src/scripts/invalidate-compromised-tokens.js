import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { prisma } from '../lib/prisma.js';
import { generateSecureToken, hashToken } from '../lib/crypto.js';
import { env } from '../config/env.js';

async function invalidateCompromisedTokens() {
  console.log('=== Invalidate Compromised Activation Tokens ===');

  const pendingInvitations = await prisma.companyInvitation.findMany({
    where: {
      acceptedAt: null,
    },
    select: {
      id: true,
      email: true,
      companyId: true,
      createdAt: true,
    },
  });

  console.log(`Found ${pendingInvitations.length} pending unaccepted invitation(s).`);

  if (pendingInvitations.length === 0) {
    console.log('No pending invitations to invalidate.');
    process.exit(0);
  }

  let rotatedCount = 0;
  for (const inv of pendingInvitations) {
    // Generate fresh cryptographic token
    const freshRawToken = generateSecureToken(32);
    const freshTokenHash = hashToken(freshRawToken);
    const freshExpiresAt = new Date(Date.now() + (env.COMPANY_INVITATION_EXPIRES_HOURS || 48) * 3600 * 1000);

    await prisma.companyInvitation.update({
      where: { id: inv.id },
      data: {
        tokenHash: freshTokenHash,
        expiresAt: freshExpiresAt,
      },
    });

    rotatedCount++;
    console.log(`✓ Rotated activation token for invitation ID ${inv.id} (${inv.email})`);
    // Note: The fresh raw token is deliberately NOT printed to prevent exposure.
  }

  console.log(`\nSuccessfully rotated ${rotatedCount} token(s). Old tokens are now completely invalidated.`);
  await prisma.$disconnect();
  process.exit(0);
}

invalidateCompromisedTokens().catch((err) => {
  console.error('Failed to invalidate tokens:', err.message);
  process.exit(1);
});
