import admin from 'firebase-admin';
import { cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let firebaseApp = null;

/**
 * Checks whether all required Firebase credentials are present in configuration.
 * Missing Firebase credentials must never prevent server startup.
 */
export function isFirebaseConfigured() {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = env.FIREBASE_PRIVATE_KEY?.trim();

  return Boolean(
    projectId &&
    clientEmail &&
    privateKey &&
    !projectId.includes('placeholder') &&
    !clientEmail.includes('placeholder') &&
    !privateKey.includes('placeholder')
  );
}

/**
 * Lazily initializes and returns the Firebase Admin instance.
 * Returns null safely if credentials are unconfigured or invalid.
 */
export function getFirebaseAdmin() {
  if (firebaseApp) {
    return firebaseApp;
  }

  if (!isFirebaseConfigured()) {
    return null;
  }

  try {
    if (admin.apps && admin.apps.length > 0) {
      firebaseApp = admin.apps[0];
      return firebaseApp;
    }

    const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

    const credential = typeof admin.credential?.cert === 'function'
      ? admin.credential.cert({
          projectId: env.FIREBASE_PROJECT_ID.trim(),
          clientEmail: env.FIREBASE_CLIENT_EMAIL.trim(),
          privateKey,
        })
      : cert({
          projectId: env.FIREBASE_PROJECT_ID.trim(),
          clientEmail: env.FIREBASE_CLIENT_EMAIL.trim(),
          privateKey,
        });

    firebaseApp = admin.initializeApp({
      credential,
    });

    logger.info(
      { projectId: env.FIREBASE_PROJECT_ID.trim() },
      'Firebase Admin SDK initialized successfully for FCM delivery'
    );
    return firebaseApp;
  } catch (error) {
    logger.warn(
      { error: error.message },
      'Failed to initialize Firebase Admin SDK. FCM push delivery will be skipped.'
    );
    return null;
  }
}

/**
 * Checks whether an FCM delivery error corresponds to an invalid or unregistered token.
 */
export function isStaleTokenError(error) {
  if (!error) return false;
  const code = (error.code || '').toLowerCase();
  const message = (error.message || '').toLowerCase();

  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument' ||
    code === 'messaging/mismatched-credential' ||
    message.includes('registration-token-not-registered') ||
    message.includes('invalid-registration-token') ||
    message.includes('not a valid fcm registration token') ||
    message.includes('requested entity was not found') ||
    message.includes('mismatched-credential') ||
    message.includes('senderid mismatch')
  );
}

/**
 * Dispatches an FCM push notification multicast to an array of device tokens.
 * Returns a structured result: { sent: number, failed: number, skipped: boolean, staleTokens: string[], errorCodes: string[] }
 */
export async function sendPushNotification({ tokens = [], title, body, deepLinkUrl, metadata = {} }) {
  if (!tokens || tokens.length === 0) {
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      staleTokens: [],
      errorCodes: [],
    };
  }

  const app = getFirebaseAdmin();
  if (!app) {
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      staleTokens: [],
      errorCodes: [],
    };
  }

  // Sanitize data payload (FCM data values must be string key-value pairs)
  const stringifiedData = {};
  if (deepLinkUrl) {
    stringifiedData.deepLinkUrl = String(deepLinkUrl);
  }
  if (metadata && typeof metadata === 'object') {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) {
        stringifiedData[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    }
  }

  const messagePayload = {
    tokens,
    notification: {
      title: String(title || ''),
      body: String(body || ''),
    },
    data: stringifiedData,
    webpush: deepLinkUrl
      ? {
          fcmOptions: {
            link: deepLinkUrl,
          },
        }
      : undefined,
  };

  try {
    const messaging = typeof app.messaging === 'function' ? app.messaging() : getMessaging(app);
    // Use sendEachForMulticast (standard in firebase-admin v11+) or sendMulticast fallback
    const sendFn = typeof messaging.sendEachForMulticast === 'function'
      ? messaging.sendEachForMulticast.bind(messaging)
      : messaging.sendMulticast.bind(messaging);

    const response = await sendFn(messagePayload);

    const staleTokens = [];
    const errorCodes = [];
    if (Array.isArray(response.responses)) {
      response.responses.forEach((resp, index) => {
        if (!resp.success && resp.error) {
          if (isStaleTokenError(resp.error)) {
            staleTokens.push(tokens[index]);
          }
          if (resp.error.code) {
            errorCodes.push(resp.error.code);
          }
        }
      });
    }

    const uniqueErrorCodes = [...new Set(errorCodes)];

    logger.info(
      {
        attempted: tokens.length,
        sent: response.successCount || 0,
        failed: response.failureCount || 0,
        errorCodes: uniqueErrorCodes,
        staleTokensCount: staleTokens.length,
      },
      'FCM push notification delivery outcome'
    );

    return {
      sent: response.successCount || 0,
      failed: response.failureCount || 0,
      skipped: false,
      staleTokens,
      errorCodes: uniqueErrorCodes,
    };
  } catch (error) {
    logger.warn(
      { error: error.message },
      'FCM push notification delivery failed unexpectedly. In-app notification preserved.'
    );

    return {
      sent: 0,
      failed: tokens.length,
      skipped: false,
      staleTokens: [],
      error: error.message,
    };
  }
}

/**
 * Reset cached app reference (used in testing).
 */
export function _resetFirebaseApp() {
  firebaseApp = null;
}

/**
 * Override app instance (used in testing).
 */
export function _setFirebaseApp(mockApp) {
  firebaseApp = mockApp;
}
