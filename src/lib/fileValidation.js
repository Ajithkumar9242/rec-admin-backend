/**
 * File Validation Utility
 *
 * Enforces magic number/content-signature validation, file extension checks,
 * size constraints, and protection against dangerous executable or script uploads.
 */

// Known dangerous executable and script extensions that must never be accepted
export const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.mjs', '.jar',
  '.php', '.asp', '.aspx', '.jsp', '.py', '.rb', '.pl', '.cgi', '.msi',
  '.dll', '.com', '.scr', '.pif', '.hta', '.cpl',
]);

/**
 * Validates a video URL format for YouTube, Vimeo, or Cloudinary
 */
export function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();

  // Reject unsafe embed HTML or javascript: protocols
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('javascript:')) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();

    // YouTube: youtube.com, youtu.be, m.youtube.com
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      return parsed.pathname === '/watch' && parsed.searchParams.has('v') || parsed.pathname.startsWith('/embed/');
    }
    if (host === 'youtu.be') {
      return parsed.pathname.length > 1;
    }

    // Vimeo: vimeo.com, player.vimeo.com
    if (host === 'vimeo.com' || host === 'www.vimeo.com') {
      return /^\/\d+/.test(parsed.pathname);
    }
    if (host === 'player.vimeo.com') {
      return parsed.pathname.startsWith('/video/');
    }

    // Cloudinary video
    if (host.includes('cloudinary.com') && parsed.pathname.includes('/video/upload/')) {
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Inspects binary magic numbers to determine true file type
 */
export function inspectFileSignature(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { detectedType: 'unknown', isExecutable: false };
  }

  // Windows PE Executable (MZ)
  if (buffer[0] === 0x4D && buffer[1] === 0x5A) {
    return { detectedType: 'application/x-dosexec', isExecutable: true };
  }

  // Linux ELF Executable (\x7fELF)
  if (buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    return { detectedType: 'application/x-executable', isExecutable: true };
  }

  // PDF (%PDF-)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2D
  ) {
    return { detectedType: 'application/pdf', extension: '.pdf', isExecutable: false };
  }

  // PNG (\x89PNG\r\n\x1a\n)
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return { detectedType: 'image/png', extension: '.png', isExecutable: false };
  }

  // JPEG (\xFF\xD8\xFF)
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { detectedType: 'image/jpeg', extension: '.jpg', isExecutable: false };
  }

  // WebP (RIFF....WEBP)
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP'
  ) {
    return { detectedType: 'image/webp', extension: '.webp', isExecutable: false };
  }

  return { detectedType: 'unknown', isExecutable: false };
}

/**
 * Validates an uploaded file buffer against security rules and optional DocumentDefinition constraints
 */
export function validateUploadedFile(file, { definition = null, allowedTypes = null, maxBytes = null } = {}) {
  if (!file) {
    const error = new Error('No file provided for upload');
    error.status = 400;
    throw error;
  }

  const originalName = file.originalname || 'document.pdf';
  const ext = ('.' + originalName.split('.').pop()).toLowerCase();

  // 1. Check dangerous extensions
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    const error = new Error(`Dangerous or executable file format "${ext}" is strictly forbidden.`);
    error.status = 400;
    throw error;
  }

  // 2. Binary signature / content inspection
  const sig = inspectFileSignature(file.buffer);
  if (sig.isExecutable) {
    const error = new Error('Binary content inspection detected an executable payload. Upload rejected.');
    error.status = 400;
    throw error;
  }

  // 3. DocumentDefinition constraints enforcement (if category is selected)
  if (definition) {
    // Max file size
    const limitBytes = (definition.maxFileSizeMb || 10) * 1024 * 1024;
    if (file.size > limitBytes) {
      const error = new Error(
        `File size (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed limit of ${definition.maxFileSizeMb} MB for ${definition.name}.`
      );
      error.status = 400;
      throw error;
    }

    // Permitted file types
    const accepted = (definition.acceptedFileTypes || []).map((t) => t.toLowerCase().trim());
    if (accepted.length > 0) {
      const declaredMime = (file.mimetype || '').toLowerCase();
      const detectedMime = (sig.detectedType || '').toLowerCase();

      const extMatches = accepted.some((a) => a === ext || a === ext.substring(1));
      const mimeMatches = accepted.some(
        (a) => a === declaredMime || (detectedMime && a === detectedMime)
      );

      if (!extMatches && !mimeMatches) {
        const error = new Error(
          `File type "${ext}" is not permitted for "${definition.name}". Allowed types: ${accepted.join(', ')}`
        );
        error.status = 400;
        throw error;
      }
    }
  }

  // 4. Fallback allowedTypes constraint
  if (allowedTypes && Array.isArray(allowedTypes) && allowedTypes.length > 0) {
    const normalized = allowedTypes.map((t) => t.toLowerCase().trim());
    const extMatches = normalized.some((a) => a === ext || a === ext.substring(1));
    const mimeMatches = normalized.some((a) => a === (file.mimetype || '').toLowerCase());

    if (!extMatches && !mimeMatches) {
      const error = new Error(`File type "${ext}" is not permitted. Allowed types: ${allowedTypes.join(', ')}`);
      error.status = 400;
      throw error;
    }
  }

  // 5. Generic max bytes constraint
  if (maxBytes && file.size > maxBytes) {
    const error = new Error(`File size exceeds maximum allowed size of ${(maxBytes / (1024 * 1024)).toFixed(2)} MB.`);
    error.status = 400;
    throw error;
  }

  return {
    valid: true,
    extension: ext,
    detectedType: sig.detectedType,
    fileSizeBytes: file.size,
  };
}
