import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// Configure authenticator options
authenticator.options = {
  window: 1, // Allow 1 step before/after for slight clock drift (±30s)
  step: 30,
  digits: 6,
};

/**
 * Generate a new TOTP secret and OTP Auth URI for Google Authenticator
 */
export function generateTotpSecret(email) {
  const secret = authenticator.generateSecret();
  const serviceName = 'RecruiTrain Admin';
  const otpAuthUrl = authenticator.keyuri(email, serviceName, secret);
  return { secret, otpAuthUrl };
}

/**
 * Generate a base64 Data URL for a QR Code
 */
export async function generateQrCodeDataUrl(otpAuthUrl) {
  return QRCode.toDataURL(otpAuthUrl, {
    margin: 2,
    width: 256,
    color: {
      dark: '#16313f', // Navy brand color
      light: '#ffffff',
    },
  });
}

/**
 * Verify a 6-digit TOTP token against a secret
 */
export function verifyTotp(token, secret) {
  if (!token || !secret) return false;
  // Clean whitespace or hyphens
  const cleanToken = token.toString().replace(/\s+/g, '').trim();
  try {
    return authenticator.verify({
      token: cleanToken,
      secret,
    });
  } catch (error) {
    return false;
  }
}
