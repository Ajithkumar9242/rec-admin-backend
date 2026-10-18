import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * Middleware ensuring an authenticated candidate session.
 */
export async function authenticateCandidate(req, res, next) {
  if (!req.session || !req.session.candidateId) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in to your candidate account.',
    });
  }

  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: req.session.candidateId },
    });

    if (!candidate || candidate.deletedAt !== null) {
      req.session.destroy();
      return res.status(401).json({
        success: false,
        error: 'Candidate account not found or deactivated. Please sign in again.',
      });
    }

    if (candidate.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        error: 'Your candidate account has been suspended. Please contact platform support.',
      });
    }

    req.candidate = candidate;
    next();
  } catch (error) {
    logger.error({ error: error.message }, 'Failed during candidate session verification');
    return res.status(500).json({
      success: false,
      error: 'Internal server error verifying candidate session.',
    });
  }
}

/**
 * Optional candidate session middleware - populates req.candidate if logged in, but does not block.
 */
export async function optionalCandidate(req, res, next) {
  if (req.session && req.session.candidateId) {
    try {
      const candidate = await prisma.candidate.findUnique({
        where: { id: req.session.candidateId },
      });
      if (candidate && candidate.deletedAt === null) {
        req.candidate = candidate;
      }
    } catch {
      // Ignore error for optional authentication
    }
  }
  next();
}
