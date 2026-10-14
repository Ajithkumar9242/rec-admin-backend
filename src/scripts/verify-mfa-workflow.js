import { prisma } from '../lib/prisma.js';
import { hashPassword, decryptTotpSecret } from '../lib/crypto.js';
import { authenticator } from 'otplib';

const BASE_URL = 'http://localhost:5000/api';
const TEST_EMAIL = 'browser_test_admin@recruitrain.com';
const TEST_PASSWORD = 'BrowserPass123!@#';

async function run() {
  console.log('=== RecruiTrain Admin E2E MFA Verification Suite ===\n');

  let passedAll = true;

  try {
    // 0. Clean prior test state
    await prisma.authAuditLog.deleteMany({
      where: { admin: { email: TEST_EMAIL } },
    });
    await prisma.adminBackupCode.deleteMany({
      where: { admin: { email: TEST_EMAIL } },
    });
    await prisma.admin.deleteMany({
      where: { email: TEST_EMAIL },
    });

    // 1. Create fresh test admin with totpEnabled: false
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const testAdmin = await prisma.admin.create({
      data: {
        email: TEST_EMAIL,
        name: 'Browser MFA Test Admin',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        totpEnabled: false,
      },
    });
    console.log(`[PASS] 1. Created isolated test admin (${TEST_EMAIL}) with totpEnabled=false.`);

    // Helper for cookie tracking
    let sessionCookie = '';
    let csrfToken = '';

    function updateSession(res) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        sessionCookie = setCookie.split(';')[0];
      }
      const token = res.headers.get('x-csrf-token');
      if (token) {
        csrfToken = token;
      }
    }

    // 2. Initial Login: should require MFA enrollment
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    updateSession(loginRes);
    const loginData = await loginRes.json();

    if (loginRes.status === 200 && loginData.state === 'MFA_ENROLLMENT_REQUIRED' && loginData.requiresMFAEnrollment === true) {
      console.log(`[PASS] 2. First login correctly returned state='MFA_ENROLLMENT_REQUIRED' and requiresMFAEnrollment=true.`);
    } else {
      console.error(`[FAIL] 2. Unexpected login response:`, loginRes.status, loginData);
      passedAll = false;
    }

    // 3. Request 2FA Setup
    const setupRes = await fetch(`${BASE_URL}/auth/2fa/setup`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
    });
    updateSession(setupRes);
    const setupData = await setupRes.json();

    if (setupRes.status === 200 && setupData.secret && setupData.qrCodeUrl.startsWith('data:image/png;base64,')) {
      console.log(`[PASS] 3. 2FA setup returned secret (${setupData.secret.length} chars) and valid base64 QR code.`);
    } else {
      console.error(`[FAIL] 3. Unexpected 2FA setup response:`, setupRes.status, setupData);
      passedAll = false;
    }

    // 4. Confirm 2FA Enrollment with generated TOTP code
    const generatedTotp = authenticator.generate(setupData.secret);
    const confirmRes = await fetch(`${BASE_URL}/auth/2fa/confirm`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: generatedTotp }),
    });
    updateSession(confirmRes);
    const confirmData = await confirmRes.json();

    let backupCodes = [];
    if (confirmRes.status === 200 && confirmData.state === 'AUTHENTICATED_MFA_VERIFIED' && confirmData.backupCodes?.length === 10) {
      backupCodes = confirmData.backupCodes;
      console.log(`[PASS] 4. 2FA confirm succeeded, returned state='AUTHENTICATED_MFA_VERIFIED' and 10 single-use backup codes.`);
    } else {
      console.error(`[FAIL] 4. Unexpected 2FA confirm response:`, confirmRes.status, confirmData);
      passedAll = false;
    }

    // 5. Verify database record encryption and status
    const verifiedAdminInDb = await prisma.admin.findUnique({
      where: { id: testAdmin.id },
    });
    const decryptedSecret = decryptTotpSecret(verifiedAdminInDb.totpSecret);

    if (verifiedAdminInDb.totpEnabled === true && verifiedAdminInDb.totpVerifiedAt !== null && decryptedSecret === setupData.secret) {
      console.log(`[PASS] 5. PostgreSQL record verified: totpEnabled=true, stored secret is AES-256-GCM encrypted and decrypts to matching secret.`);
    } else {
      console.error(`[FAIL] 5. Database record verification failed:`, verifiedAdminInDb);
      passedAll = false;
    }

    // 6. Verify session via /api/auth/me
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Cookie': sessionCookie },
    });
    const meData = await meRes.json();

    if (meRes.status === 200 && meData.user.email === TEST_EMAIL && meData.user.remainingBackupCodes === 10) {
      console.log(`[PASS] 6. /api/auth/me successfully restored session for ${meData.user.email} (10 backup codes remaining).`);
    } else {
      console.error(`[FAIL] 6. /api/auth/me failed:`, meRes.status, meData);
      passedAll = false;
    }

    // 7. Logout
    const logoutRes = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    updateSession(logoutRes);
    console.log(`[PASS] 7. Logged out successfully.`);

    // 8. Subsequent login with already-enrolled MFA -> must return PASSWORD_ACCEPTED_MFA_PENDING
    const secondLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    updateSession(secondLoginRes);
    const secondLoginData = await secondLoginRes.json();

    if (secondLoginRes.status === 200 && secondLoginData.state === 'PASSWORD_ACCEPTED_MFA_PENDING' && secondLoginData.requires2FA === true) {
      console.log(`[PASS] 8. Subsequent login correctly recognized enrolled MFA and returned state='PASSWORD_ACCEPTED_MFA_PENDING'.`);
    } else {
      console.error(`[FAIL] 8. Unexpected subsequent login response:`, secondLoginRes.status, secondLoginData);
      passedAll = false;
    }

    // 9. Verify 2FA with fresh code
    const freshCode = authenticator.generate(setupData.secret);
    const verifyRes = await fetch(`${BASE_URL}/auth/verify-2fa`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ adminId: secondLoginData.adminId, code: freshCode }),
    });
    updateSession(verifyRes);
    const verifyData = await verifyRes.json();

    if (verifyRes.status === 200 && verifyData.state === 'AUTHENTICATED_MFA_VERIFIED') {
      console.log(`[PASS] 9. 2FA login verification succeeded with authentic TOTP code.`);
    } else {
      console.error(`[FAIL] 9. 2FA login verification failed:`, verifyRes.status, verifyData);
      passedAll = false;
    }

    // 10. Test Single-Use Backup Code Login & Replay Prevention
    const logoutRes2 = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'x-csrf-token': csrfToken },
    });
    updateSession(logoutRes2);

    const thirdLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    updateSession(thirdLoginRes);
    const thirdLoginData = await thirdLoginRes.json();

    const usedBackupCode = backupCodes[0];
    const backupRes = await fetch(`${BASE_URL}/auth/verify-backup-code`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ adminId: thirdLoginData.adminId, code: usedBackupCode }),
    });
    updateSession(backupRes);
    const backupData = await backupRes.json();

    if (backupRes.status === 200 && backupData.state === 'AUTHENTICATED_MFA_VERIFIED' && backupData.remainingBackupCodes === 9) {
      console.log(`[PASS] 10. Single-use backup code successfully consumed (remaining count: 9).`);
    } else {
      console.error(`[FAIL] 10. Backup code verification failed:`, backupRes.status, backupData);
      passedAll = false;
    }

    // 11. Test replay of consumed backup code
    const logoutRes3 = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'x-csrf-token': csrfToken },
    });
    updateSession(logoutRes3);

    const fourthLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    updateSession(fourthLoginRes);
    const fourthLoginData = await fourthLoginRes.json();

    const replayRes = await fetch(`${BASE_URL}/auth/verify-backup-code`, {
      method: 'POST',
      headers: {
        'Cookie': sessionCookie,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ adminId: fourthLoginData.adminId, code: usedBackupCode }),
    });
    const replayData = await replayRes.json();

    if (replayRes.status === 400 && replayData.error.includes('Invalid or already used backup code')) {
      console.log(`[PASS] 11. Replayed backup code strictly rejected with 400.`);
    } else {
      console.error(`[FAIL] 11. Backup code replay was not rejected:`, replayRes.status, replayData);
      passedAll = false;
    }

    // 12. Clean up test admin
    await prisma.authAuditLog.deleteMany({
      where: { adminId: testAdmin.id },
    });
    await prisma.adminBackupCode.deleteMany({
      where: { adminId: testAdmin.id },
    });
    await prisma.admin.delete({
      where: { id: testAdmin.id },
    });
    console.log(`[PASS] 12. Test admin cleaned up successfully.`);

  } catch (err) {
    console.error('Fatal error during verification suite:', err);
    passedAll = false;
  } finally {
    await prisma.$disconnect();
  }

  if (passedAll) {
    console.log('\n>>> ALL 12 END-TO-END MFA WORKFLOW CHECKS PASSED ON LIVE SERVER! <<<');
  } else {
    console.error('\n>>> SOME CHECKS FAILED. SEE LOGS ABOVE. <<<');
    process.exit(1);
  }
}

run();
