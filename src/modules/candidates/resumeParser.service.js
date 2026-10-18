import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { logger } from '../../lib/logger.js';
import { inspectFileSignature } from '../../lib/fileValidation.js';
import { validateResumeFile } from '../configuration/candidateVisibilityPolicy.js';

export class ResumeParserService {
  /**
   * Extract readable text from an uploaded resume buffer (PDF, DOCX, DOC)
   */
  static async extractText(file) {
    if (!file || !file.buffer) {
      throw new Error('No file buffer provided for text extraction');
    }

    const originalName = (file.originalname || '').toLowerCase();
    const mimeType = (file.mimetype || '').toLowerCase();

    // 1. PDF Documents
    if (originalName.endsWith('.pdf') || mimeType === 'application/pdf') {
      try {
        const data = await pdfParse(file.buffer);
        const text = (data.text || '').trim();
        return {
          text,
          supported: true,
          format: 'PDF',
          success: text.length > 0,
          error: text.length === 0 ? 'Document contains no extractable text (it may be scanned or empty).' : null,
        };
      } catch (err) {
        logger.warn({ error: err.message }, 'pdf-parse failed on uploaded resume');
        return {
          text: '',
          supported: true,
          format: 'PDF',
          success: false,
          error: `Failed to extract text from PDF: ${err.message}`,
        };
      }
    }

    // 2. DOCX Documents
    if (
      originalName.endsWith('.docx') ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      try {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        const text = (result.value || '').trim();
        return {
          text,
          supported: true,
          format: 'DOCX',
          success: text.length > 0,
          error: text.length === 0 ? 'DOCX document contains no readable text.' : null,
        };
      } catch (err) {
        logger.warn({ error: err.message }, 'mammoth failed on uploaded resume');
        return {
          text: '',
          supported: true,
          format: 'DOCX',
          success: false,
          error: `Failed to extract text from DOCX: ${err.message}`,
        };
      }
    }

    // 3. Legacy DOC Documents (.doc)
    if (originalName.endsWith('.doc') || mimeType === 'application/msword') {
      // Legacy binary DOC format requires specialized OLE2/Word97 streams.
      // Per requirements: Explain parsing failed while preserving upload and manual entry.
      return {
        text: '',
        supported: false,
        format: 'DOC',
        success: false,
        error:
          'Automatic text extraction is unsupported for legacy .doc binary files. Please enter candidate details manually.',
      };
    }

    return {
      text: '',
      supported: false,
      format: 'UNKNOWN',
      success: false,
      error: 'Unsupported file format for text extraction.',
    };
  }

  /**
   * Parse structured, reliable fields from extracted resume text
   */
  static parseFields(text) {
    if (!text || typeof text !== 'string') {
      return {};
    }

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const extracted = {};

    // 1. Email Address
    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (emailMatch) {
      extracted.email = emailMatch[0].toLowerCase().trim();
    }

    // 2. LinkedIn Profile
    const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|profile)\/([a-zA-Z0-9_\-%]+)\/?/i);
    if (linkedinMatch) {
      extracted.linkedinUrl = linkedinMatch[0].startsWith('http')
        ? linkedinMatch[0]
        : `https://${linkedinMatch[0]}`;
    }

    // 3. GitHub Profile
    const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_\-%]+)\/?/i);
    if (githubMatch) {
      extracted.githubUrl = githubMatch[0].startsWith('http')
        ? githubMatch[0]
        : `https://${githubMatch[0]}`;
    }

    // 4. Portfolio URL
    const portfolioMatch = text.match(/(?:portfolio|website|homepage|site):\s*(https?:\/\/[^\s]+)/i);
    if (portfolioMatch) {
      extracted.portfolioUrl = portfolioMatch[1].trim();
    }

    // 5. Phone / Mobile Number & Alternate Mobile
    const phoneLabels = text.match(/(?:phone|mobile|cell|tel)[:\s]*([+\d\s().-]{8,22})/i);
    const altPhoneLabels = text.match(/(?:alternate|alt|secondary)[:\s]*(?:mobile|phone|tel)?[:\s]*([+\d\s().-]{8,22})/i);

    if (phoneLabels) {
      extracted.phone = phoneLabels[1].trim();
    }
    if (altPhoneLabels) {
      extracted.alternateMobile = altPhoneLabels[1].trim();
    }

    if (!extracted.phone) {
      // General phone regex fallback
      const generalPhones = text.match(/(?:\+?\d{1,4}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g);
      if (generalPhones) {
        const cleanPhones = generalPhones
          .map((p) => p.trim())
          .filter((p) => p.replace(/\D/g, '').length >= 8 && p.replace(/\D/g, '').length <= 15);
        if (cleanPhones.length > 0) {
          extracted.phone = cleanPhones[0];
          if (cleanPhones.length > 1 && !extracted.alternateMobile && cleanPhones[1] !== cleanPhones[0]) {
            extracted.alternateMobile = cleanPhones[1];
          }
        }
      }
    }

    // 6. Candidate Name (First Name, Middle Name, Last Name)
    // Check for explicit name label first
    const explicitNameMatch = text.match(/(?:name|candidate name|full name)[:\s]*([a-zA-ZÀ-ÿ'.-]+(?:\s+[a-zA-ZÀ-ÿ'.-]+){1,3})/i);
    let candidateNameString = explicitNameMatch ? explicitNameMatch[1].trim() : null;

    if (!candidateNameString) {
      // Look at top header lines (first 5 lines)
      const ignoredHeaders = new Set([
        'curriculum vitae', 'resume', 'cv', 'profile', 'contact', 'summary',
        'personal details', 'page 1', 'page 1 of 1', 'bio', 'about me',
      ]);
      for (const line of lines.slice(0, 5)) {
        const lower = line.toLowerCase();
        if (ignoredHeaders.has(lower) || lower.includes('@') || lower.includes('http') || /\d/.test(line)) {
          continue;
        }
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[a-zA-ZÀ-ÿ'.-]+$/.test(w))) {
          candidateNameString = line;
          break;
        }
      }
    }

    if (candidateNameString) {
      const parts = candidateNameString.split(/\s+/).filter(Boolean);
      if (parts.length === 2) {
        extracted.firstName = parts[0];
        extracted.lastName = parts[1];
      } else if (parts.length === 3) {
        extracted.firstName = parts[0];
        extracted.middleName = parts[1];
        extracted.lastName = parts[2];
      } else if (parts.length >= 4) {
        extracted.firstName = parts[0];
        extracted.middleName = parts.slice(1, -1).join(' ');
        extracted.lastName = parts[parts.length - 1];
      }
    }

    // 7. Current Job Title & Current Company
    const jobTitleLabel = text.match(/(?:current job title|current position|current role|job title|title|position)[:\s]*([^\n\r,]+)/i);
    const companyLabel = text.match(/(?:current company|current employer|company|employer)[:\s]*([^\n\r,]+)/i);

    if (jobTitleLabel) {
      extracted.currentJobTitle = jobTitleLabel[1].trim();
      extracted.profession = extracted.currentJobTitle;
    }
    if (companyLabel) {
      extracted.currentCompany = companyLabel[1].trim();
    }

    // Check for "Job Title at Company" pattern if not yet found
    if (!extracted.currentJobTitle || !extracted.currentCompany) {
      const atMatch = text.match(/([a-zA-Z\s]+(?:Developer|Engineer|Manager|Conductor|Architect|Specialist|Consultant|Director|Designer|Officer))\s+(?:at|@)\s+([a-zA-Z0-9\s&.,-]+)/i);
      if (atMatch) {
        if (!extracted.currentJobTitle) {
          extracted.currentJobTitle = atMatch[1].trim();
          if (!extracted.profession) extracted.profession = extracted.currentJobTitle;
        }
        if (!extracted.currentCompany) {
          extracted.currentCompany = atMatch[2].split(/\n|\r|,/)[0].trim();
        }
      }
    }

    // 8. Years of Experience
    const expMatch = text.match(/(?:(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)(?:\s+of)?\s+experience)|(?:experience[:\s]+(\d+(?:\.\d+)?)\+?\s*(?:years|yrs))/i);
    if (expMatch) {
      const years = parseFloat(expMatch[1] || expMatch[2]);
      if (!isNaN(years) && years >= 0 && years <= 60) {
        extracted.yearsOfExperience = years;
      }
    }

    // 9. Location & Address Details
    const locationMatch = text.match(/(?:preferred location|location|address)[:\s]*([^\n\r]+)/i);
    if (locationMatch) {
      const loc = locationMatch[1].trim();
      extracted.preferredLocation = loc;
    }

    // Postal code (e.g. German 5-digit postal code)
    const postalMatch = text.match(/\b(\d{5})\b/);
    if (postalMatch) {
      extracted.postalCode = postalMatch[1];
    }

    // German City Detection
    const cityMatch = text.match(/\b(Berlin|München|Munich|Hamburg|Frankfurt|Köln|Cologne|Stuttgart|Düsseldorf|Leipzig|Dresden|Bonn|Nürnberg|Nuremberg|Hannover|Bremen|Essen|Dortmund)\b/i);
    if (cityMatch) {
      extracted.city = cityMatch[1];
      extracted.country = 'DE';
    }

    // 10. Strict omission of sensitive fields:
    // Do NOT infer Date of Birth, Gender, Marital Status, Nationality, Passport Number, Visa Status, Work Permit Authorized.

    return extracted;
  }

  /**
   * Parse resume file workflow: text extraction + field recognition
   */
  static async parseResume(file) {
    const extraction = await this.extractText(file);

    if (!extraction.supported) {
      return {
        parseSuccess: false,
        extracted: {},
        message: extraction.error || 'Text extraction is unsupported for this document format. Please enter details manually.',
        rawExtractedTextPreview: null,
      };
    }

    if (!extraction.success) {
      return {
        parseSuccess: false,
        extracted: {},
        message: extraction.error || 'Failed to extract readable text from document. Please enter details manually.',
        rawExtractedTextPreview: null,
      };
    }

    const fields = this.parseFields(extraction.text);
    const fieldCount = Object.keys(fields).length;

    return {
      parseSuccess: fieldCount > 0,
      extracted: fields,
      message:
        fieldCount > 0
          ? `Successfully recognized ${fieldCount} field(s) from resume.`
          : 'Document was read, but no standard candidate fields could be reliably recognized. Please enter details manually.',
      rawExtractedTextPreview: null, // Do not persist or leak raw text
    };
  }
}
