import readline from 'readline';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

function promptPassword(promptMessage = 'Enter Administrator Password: ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const stdin = process.stdin;
    if (!stdin.isTTY) {
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    process.stdout.write(promptMessage);
    let pwd = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (chunk) => {
      const str = chunk.toString();
      for (const char of str) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode(wasRaw);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(pwd);
          return;
        } else if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        } else if (char === '\b' || char === '\x7f') {
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          pwd += char;
          process.stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}

function promptText(promptMessage) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptMessage, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function bootstrapSuperAdmin() {
  console.log('--- RecruiTrain Super Admin Provisioning Tool ---');

  const emailArgIndex = process.argv.indexOf('--email');
  const emailFromArg = emailArgIndex !== -1 ? process.argv[emailArgIndex + 1] : null;
  let email = (
    emailFromArg ||
    process.argv.find((a) => a.startsWith('--email='))?.split('=')[1] ||
    process.env.SUPER_ADMIN_EMAIL ||
    env.SUPER_ADMIN_EMAIL ||
    ''
  ).trim().toLowerCase();

  const nameArgIndex = process.argv.indexOf('--name');
  const nameFromArg = nameArgIndex !== -1 ? process.argv[nameArgIndex + 1] : null;
  let name = (
    nameFromArg ||
    process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] ||
    process.env.SUPER_ADMIN_NAME ||
    env.SUPER_ADMIN_NAME ||
    'Platform Administrator'
  ).trim();

  const roleArgIndex = process.argv.indexOf('--role');
  const roleFromArg = roleArgIndex !== -1 ? process.argv[roleArgIndex + 1] : null;
  const role = (
    roleFromArg ||
    process.argv.find((a) => a.startsWith('--role='))?.split('=')[1] ||
    'SUPER_ADMIN'
  ).trim().toUpperCase();

  const pwdArgIndex = process.argv.indexOf('--password');
  const pwdFromArg = pwdArgIndex !== -1 ? process.argv[pwdArgIndex + 1] : null;
  let password = (
    pwdFromArg ||
    process.argv.find((a) => a.startsWith('--password='))?.split('=')[1] ||
    process.env.SUPER_ADMIN_PASSWORD ||
    env.SUPER_ADMIN_PASSWORD ||
    ''
  );

  if (pwdFromArg || process.argv.some((a) => a.startsWith('--password='))) {
    console.warn('[SECURITY WARNING] Providing passwords via command-line arguments (--password) exposes credentials in shell history and process listings (e.g. ps aux). Prefer secure interactive prompt or piped stdin.');
  }

  if (!email && process.stdin.isTTY) {
    email = (await promptText('Enter Administrator Email: ')).trim().toLowerCase();
  }

  if (!email) {
    console.error('ERROR: Admin email must be provided via --email <address>, SUPER_ADMIN_EMAIL environment variable, or interactive prompt.');
    console.error('Example: node src/scripts/bootstrap-superadmin.js --email admin@clientdomain.com --name "Client Administrator"');
    process.exit(1);
  }

  const existing = await prisma.admin.findUnique({
    where: { email },
  });

  const resetMFA = process.argv.includes('--reset-mfa');
  const updatePassword = process.argv.includes('--update-password') || process.argv.includes('--force');

  // If password is required and not provided yet, securely prompt interactively
  if (!password && (!existing || updatePassword)) {
    password = await promptPassword('Enter Administrator Password (min 8 chars): ');
  }

  if (existing) {
    console.log(`Administrator account for ${email} already exists (Role: ${existing.role}, Status: ${existing.status}).`);

    if (resetMFA || updatePassword) {
      const updateData = {
        role: existing.role || 'SUPER_ADMIN',
        status: 'ACTIVE',
        failedLoginAttempts: 0,
        lockedUntil: null,
      };

      if (updatePassword) {
        if (!password || password.length < 8) {
          console.error('ERROR: Valid password (>=8 chars) must be provided to update password.');
          process.exit(1);
        }
        updateData.passwordHash = await hashPassword(password);
        updateData.passwordChangedAt = new Date();
      }

      if (resetMFA) {
        updateData.totpSecret = null;
        updateData.totpEnabled = false;
        updateData.totpVerifiedAt = null;
      }

      await prisma.admin.update({
        where: { id: existing.id },
        data: updateData,
      });

      if (resetMFA) {
        await prisma.adminBackupCode.deleteMany({ where: { adminId: existing.id } });

        // Revoke active sessions in Redis to prevent session reuse
        let revokedSessions = 0;
        try {
          const { default: Redis } = await import('ioredis');
          const { revokeAdminSessions } = await import('../lib/redis.js');
          const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
          await redis.connect();
          revokedSessions = await revokeAdminSessions(existing.id, redis);
          await redis.quit();
          console.log(`Revoked ${revokedSessions} active session(s) from Redis.`);
        } catch (redisErr) {
          console.warn(`Note: Could not revoke Redis sessions (${redisErr.message}). Continuing.`);
        }

        // Record security audit events
        await prisma.authAuditLog.create({
          data: {
            adminId: existing.id,
            eventType: 'TWO_FACTOR_DISABLED',
            details: { action: 'bootstrap_mfa_reset', email, resetBy: 'cli' },
          },
        });

        if (revokedSessions > 0) {
          await prisma.authAuditLog.create({
            data: {
              adminId: existing.id,
              eventType: 'SESSION_REVOKED',
              details: { action: 'bootstrap_mfa_reset_sessions_revoked', count: revokedSessions },
            },
          });
        }

        console.log(`MFA state safely reset for ${email}. Next login will mandate initial MFA enrollment.`);
      }

      if (updatePassword) {
        console.log(`Password successfully updated for ${email}.`);
      }
    } else {
      console.log('Account is unchanged. To reset MFA state, pass --reset-mfa. To refresh password, pass --update-password.');
    }
  } else {
    if (!password || password.length < 8) {
      console.error('ERROR: Administrator password (at least 8 characters) must be provided to create new admin.');
      process.exit(1);
    }
    const passwordHash = await hashPassword(password);
    const created = await prisma.admin.create({
      data: {
        email,
        name,
        passwordHash,
        role: role === 'ADMIN' ? 'ADMIN' : 'SUPER_ADMIN',
        status: 'ACTIVE',
        totpEnabled: false,
      },
    });

    await prisma.authAuditLog.create({
      data: {
        adminId: created.id,
        eventType: 'LOGIN_SUCCESS',
        details: { action: 'super_admin_bootstrapped', email },
      },
    });

    console.log(`Super Admin account successfully created for ${email}.`);
    console.log('Initial sign-in will require mandatory MFA enrollment.');
  }

  await prisma.$disconnect();
  console.log('Bootstrap completed successfully.');
}

bootstrapSuperAdmin().catch((err) => {
  console.error('Bootstrap failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
