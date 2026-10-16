/**
 * Candidate Visibility Policy & File Validation Foundation
 *
 * Enforces employer visibility rules (resumes, full name, email, phone) on backend responses,
 * validates candidate-facing employer details, and rigorously verifies resume file MIME types
 * and file extensions against persisted platform settings.
 */

// Canonical MIME type to extension mappings for document formats
export const RESUME_MIME_MAP = {
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.rtf': ['application/rtf', 'text/rtf'],
  '.txt': ['text/plain'],
};

// Strict forbidden executable / script extensions
export const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.php', '.phtml', '.js', '.ts',
  '.vbs', '.py', '.rb', '.pl', '.dll', '.scr', '.msi', '.com', '.htm',
  '.html', '.jar', '.apk', '.bin', '.wsf',
]);

/**
 * Validates a candidate resume file against extension, MIME type, and allowed settings.
 *
 * @param {string} fileName
 * @param {string} mimeType
 * @param {string[]} allowedTypesList Array of allowed extensions and/or MIME types
 * @returns {{ valid: boolean, error?: string, normalizedExtension?: string }}
 */
export function validateResumeFile(fileName, mimeType, allowedTypesList = []) {
  if (!fileName || typeof fileName !== 'string') {
    return { valid: false, error: 'File name is required.' };
  }

  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === fileName.length - 1) {
    return { valid: false, error: 'File missing an extension.' };
  }

  const ext = fileName.slice(dotIndex).toLowerCase().trim();

  // 1. Block dangerous executable or script extensions unconditionally
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    return { valid: false, error: `Files with extension "${ext}" are strictly prohibited for security.` };
  }

  // 2. Normalize and check against configured allowed types
  const normalizedAllowed = (allowedTypesList || []).map((t) => t.toLowerCase().trim());
  const extAllowed = normalizedAllowed.includes(ext);
  const mimeAllowed = mimeType ? normalizedAllowed.includes(mimeType.toLowerCase().trim()) : false;

  if (!extAllowed && !mimeAllowed) {
    return {
      valid: false,
      error: `File type "${ext}" is not in the list of accepted resume formats. Allowed: ${normalizedAllowed.join(', ')}`,
    };
  }

  // 3. Strict MIME-type to extension verification (prevent header/extension spoofing)
  if (mimeType && RESUME_MIME_MAP[ext]) {
    const validMimesForExt = RESUME_MIME_MAP[ext];
    const incomingMime = mimeType.toLowerCase().trim();
    if (!validMimesForExt.includes(incomingMime)) {
      return {
        valid: false,
        error: `MIME type mismatch: extension "${ext}" does not correspond to MIME type "${mimeType}".`,
      };
    }
  }

  return { valid: true, normalizedExtension: ext };
}

/**
 * Enforces employer visibility rules on candidate profile and application data.
 *
 * Platform administrators bypass restrictions.
 * Employers only see data permitted by the persisted platform settings.
 *
 * @param {object} candidate Candidate entity or record
 * @param {object} settings Persisted platform settings
 * @param {object} [viewerContext] Viewer identity context (e.g. { role, isEmployer })
 * @returns {object} Filtered / masked candidate object
 */
export function enforceCandidateVisibility(candidate, settings, viewerContext = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return candidate;
  }

  // Admins and Super Admins always have unrestricted platform oversight
  if (viewerContext.role === 'SUPER_ADMIN' || viewerContext.role === 'ADMIN') {
    return { ...candidate };
  }

  const isEmployer = viewerContext.isEmployer || viewerContext.companyId || viewerContext.role === 'EMPLOYER';
  if (!isEmployer) {
    return { ...candidate };
  }

  const sanitized = { ...candidate };

  // 1. Candidate Full Name Visibility
  if (!settings?.showCandidateFullName) {
    if (sanitized.name) {
      sanitized.name = `Candidate #${String(sanitized.id || 'ANONYMOUS').slice(0, 8).toUpperCase()}`;
    }
    if (sanitized.firstName || sanitized.lastName) {
      sanitized.firstName = 'Candidate';
      sanitized.lastName = `#${String(sanitized.id || 'ANON').slice(0, 6).toUpperCase()}`;
    }
  }

  // 2. Candidate Email Visibility
  if (!settings?.showCandidateEmail) {
    sanitized.email = '[RESTRICTED_BY_PLATFORM_POLICY]';
  }

  // 3. Candidate Phone Number Visibility
  if (!settings?.showCandidatePhone) {
    sanitized.phone = '[RESTRICTED_BY_PLATFORM_POLICY]';
    if (sanitized.phoneNumber) {
      sanitized.phoneNumber = '[RESTRICTED_BY_PLATFORM_POLICY]';
    }
  }

  // 4. Candidate Resume Visibility
  if (!settings?.showCandidateResumes) {
    delete sanitized.resumeUrl;
    delete sanitized.resumeDownloadUrl;
    delete sanitized.resumeKey;
    sanitized.resumeAvailable = false;
    sanitized.resumeStatus = 'RESTRICTED_BY_PLATFORM_POLICY';
  }

  return sanitized;
}

/**
 * Checks whether an employer is authorized to download a candidate resume.
 *
 * @param {object} settings Persisted platform settings
 * @param {object} viewerContext Viewer identity context
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkResumeDownloadAuthorization(settings, viewerContext = {}) {
  // Admins always allowed
  if (viewerContext.role === 'SUPER_ADMIN' || viewerContext.role === 'ADMIN') {
    return { allowed: true };
  }

  if (!settings?.showCandidateResumes) {
    return {
      allowed: false,
      reason: 'Resume downloads are disabled by platform employer visibility settings.',
    };
  }

  return { allowed: true };
}

/**
 * Enforces visibility of employer/company contact details when viewed by candidates.
 *
 * @param {object} employer Employer entity or record
 * @param {object} settings Persisted platform settings
 * @returns {object} Filtered employer object
 */
export function enforceEmployerContactVisibility(employer, settings) {
  if (!employer || typeof employer !== 'object') {
    return employer;
  }

  if (settings?.showEmployerContactDetails) {
    return { ...employer };
  }

  const sanitized = { ...employer };
  delete sanitized.billingEmail;
  delete sanitized.billingAddress;
  delete sanitized.contactEmail;
  delete sanitized.contactPhone;
  sanitized.contactDetailsHidden = true;

  return sanitized;
}
