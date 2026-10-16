import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');

dotenv.config({ path: envPath });

import { env } from '../config/env.js';
import { verifySmtpTransport, sendTestEmail, getMailStatus } from '../lib/mailer.js';

async function runDiagnostic() {
  console.log('=== RecruiTrain SMTP Configuration Diagnostic ===');
  console.log(`Environment file loaded from: ${envPath}`);
  console.log(`Node Environment: ${env.NODE_ENV}`);
  console.log('--- Configuration Settings ---');
  console.log(`SMTP Host: ${env.SMTP_HOST || '(NOT CONFIGURED)'}`);
  console.log(`SMTP Port: ${env.SMTP_PORT || '(NOT CONFIGURED)'}`);
  console.log(`SMTP Secure: ${env.SMTP_SECURE}`);
  console.log(`SMTP User: ${env.SMTP_USER || '(NOT CONFIGURED)'}`);
  console.log(`SMTP Pass Set: ${Boolean(env.SMTP_PASS)} (length: ${env.SMTP_PASS ? env.SMTP_PASS.length : 0})`);
  console.log(`Mail From Name: ${env.MAIL_FROM_NAME}`);
  console.log(`Mail From Address: ${env.MAIL_FROM_ADDRESS}`);
  console.log('------------------------------');

  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.error('❌ Incomplete SMTP configuration. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in backend/.env');
    process.exit(1);
  }

  console.log('\nTesting SMTP transport connectivity and authentication...');
  const verifyResult = await verifySmtpTransport();

  if (verifyResult.success) {
    console.log('✅ SMTP Transport Verification: SUCCESSFUL');
    console.log('   The SMTP server accepted authentication credentials.');
  } else {
    console.error('❌ SMTP Transport Verification: FAILED');
    console.error(`   Error details: ${verifyResult.error}`);
    console.log('\nRemediation advice:');
    if (verifyResult.error && verifyResult.error.includes('535') || verifyResult.error?.includes('BadCredentials')) {
      console.log('   • Gmail returned 535 BadCredentials.');
      console.log('   • Ensure 2-Step Verification is active on the Google account.');
      console.log('   • Generate a dedicated 16-character App Password at: https://myaccount.google.com/apppasswords');
      console.log('   • Ensure the SMTP_USER corresponds exactly to the Google account generating the App Password.');
    }
  }

  // Check if test delivery was requested via --to=<email>
  const toArg = process.argv.find((arg) => arg.startsWith('--to='));
  if (toArg) {
    const recipient = toArg.replace('--to=', '').trim();
    if (recipient) {
      console.log(`\nAttempting safe test email delivery to: ${recipient}...`);
      const deliveryResult = await sendTestEmail({ to: recipient });
      if (deliveryResult.delivered) {
        console.log(`✅ Test Email Delivered: SUCCESS (Message ID: ${deliveryResult.messageId})`);
      } else {
        console.error(`❌ Test Email Delivery: FAILED (${deliveryResult.error})`);
      }
    }
  } else {
    console.log('\n(To test actual email dispatch, run with: node src/scripts/test-smtp.js --to=your-email@domain.com)');
  }

  process.exit(verifyResult.success ? 0 : 1);
}

runDiagnostic().catch((err) => {
  console.error('Unexpected diagnostic error:', err.message);
  process.exit(1);
});
