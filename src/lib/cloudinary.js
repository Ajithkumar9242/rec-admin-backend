import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let isConfigured = false;

function initCloudinary() {
  if (isConfigured) return true;

  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    isConfigured = true;
    return true;
  }

  return false;
}

export function isCloudinaryConfigured() {
  return initCloudinary();
}

export function getCloudinaryStatus() {
  const configured = Boolean(
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
  );
  return {
    configured,
    cloudName: configured ? env.CLOUDINARY_CLOUD_NAME : null,
    folder: env.CLOUDINARY_FOLDER || 'recruitrain',
  };
}

/**
 * Cloudinary asset namespaces for RecruiTrain
 */
export const CLOUDINARY_NAMESPACES = {
  LOGOS: `${env.CLOUDINARY_FOLDER || 'recruitrain'}/companies/logos`,
  BANNERS: `${env.CLOUDINARY_FOLDER || 'recruitrain'}/companies/banners`,
  VIDEOS: `${env.CLOUDINARY_FOLDER || 'recruitrain'}/companies/videos`,
  DOCUMENTS: `${env.CLOUDINARY_FOLDER || 'recruitrain'}/companies/documents/private`,
};

/**
 * Generate signed upload parameters for client or server upload
 */
export function generateUploadSignature({ folder, resourceType = 'auto', isPrivate = false } = {}) {
  if (!initCloudinary()) {
    throw new Error('Cloudinary is not configured. Please set Cloudinary credentials in environment.');
  }

  const timestamp = Math.round(Date.now() / 1000);
  const targetFolder = folder || CLOUDINARY_NAMESPACES.LOGOS;

  const paramsToSign = {
    folder: targetFolder,
    timestamp,
  };

  if (isPrivate) {
    paramsToSign.type = 'authenticated';
  }

  const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET);

  return {
    signature,
    timestamp,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder: targetFolder,
    resourceType,
    isPrivate,
  };
}

/**
 * Upload a memory Buffer to Cloudinary
 */
export async function uploadBuffer(buffer, {
  folder,
  resourceType = 'auto',
  publicId,
  isPrivate = false,
  mimeType,
} = {}) {
  if (!initCloudinary()) {
    throw new Error('Cloudinary is not configured. File upload cannot proceed.');
  }

  const targetFolder = folder || CLOUDINARY_NAMESPACES.LOGOS;

  const uploadOptions = {
    folder: targetFolder,
    resource_type: resourceType,
    use_filename: false,
    unique_filename: true,
    overwrite: false,
  };

  if (publicId) {
    uploadOptions.public_id = publicId;
  }

  if (isPrivate) {
    uploadOptions.type = 'authenticated';
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          logger.error({ error: error.message, folder: targetFolder }, 'Cloudinary upload failed');
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        logger.info({ publicId: result.public_id, secureUrl: result.secure_url }, 'Cloudinary upload successful');
        resolve({
          publicId: result.public_id,
          secureUrl: result.secure_url,
          format: result.format,
          resourceType: result.resource_type,
          bytes: result.bytes,
          version: result.version,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

/**
 * Generate a private, expiring download URL for confidential documents
 */
export function getPrivateDownloadUrl(publicId, {
  resourceType = 'image',
  expiresInSeconds = 3600,
  format,
} = {}) {
  if (!initCloudinary()) {
    throw new Error('Cloudinary is not configured.');
  }

  const expiresAt = Math.round(Date.now() / 1000) + expiresInSeconds;

  if (resourceType === 'raw') {
    // Cloudinary authenticated raw files must be signed via private_download_url
    return cloudinary.utils.private_download_url(publicId, format || '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: expiresAt,
    });
  }

  const options = {
    resource_type: resourceType,
    type: 'authenticated',
    sign_url: true,
    expires_at: expiresAt,
  };

  if (format) {
    options.format = format;
  }

  return cloudinary.url(publicId, options);
}

/**
 * Safely fetch a private asset buffer from Cloudinary via authenticated server-side stream
 */
export async function fetchPrivateAssetBuffer(publicId, { resourceType = 'raw' } = {}) {
  if (!initCloudinary()) {
    throw new Error('Cloudinary is not configured.');
  }

  const downloadUrl = getPrivateDownloadUrl(publicId, {
    resourceType,
    expiresInSeconds: 300,
  });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logger.warn(
      { publicId, status: response.status, resourceType },
      'Failed to fetch private asset from Cloudinary storage'
    );
    const error = new Error(`Storage provider returned HTTP ${response.status}`);
    error.status = response.status === 404 ? 404 : 502;
    error.details = errorText;
    throw error;
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = response.headers.get('content-type') || 'application/pdf';

  return {
    buffer,
    contentType,
    length: buffer.length,
  };
}

/**
 * Delete an asset from Cloudinary
 */
export async function deleteCloudinaryAsset(publicId, { resourceType = 'image', isPrivate = false } = {}) {
  if (!initCloudinary()) {
    logger.warn('Cloudinary is not configured. Skipping remote asset deletion.');
    return { success: false, reason: 'unconfigured' };
  }

  try {
    const options = {
      resource_type: resourceType,
    };
    if (isPrivate) {
      options.type = 'authenticated';
    }

    const result = await cloudinary.uploader.destroy(publicId, options);
    logger.info({ publicId, result }, 'Cloudinary asset deleted');
    return { success: result.result === 'ok' || result.result === 'not found', result };
  } catch (error) {
    logger.error({ error: error.message, publicId }, 'Failed to delete Cloudinary asset');
    return { success: false, error: error.message };
  }
}
