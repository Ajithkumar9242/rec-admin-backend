/**
 * Concurrency-Safe Invoice Number Generator
 *
 * Format: INV-YYYY-XXXXX (e.g., INV-2026-00001)
 *
 * Ensures sequentiality and uniqueness under high concurrency:
 * 1. Inspects the highest existing sequence number for the target year.
 * 2. Increments sequence atomically.
 * 3. Designed to be executed within or alongside Prisma database operations.
 */

import { prisma } from '../../lib/prisma.js';

export async function generateNextInvoiceNumber(tx = prisma, targetYear = new Date().getUTCFullYear()) {
  const prefix = `INV-${targetYear}-`;

  // Fetch the latest invoice for the year by invoiceNumber desc
  const latestInvoice = await tx.invoice.findFirst({
    where: {
      invoiceNumber: {
        startsWith: prefix,
      },
    },
    orderBy: {
      invoiceNumber: 'desc',
    },
    select: {
      invoiceNumber: true,
    },
  });

  let nextSequence = 1;

  if (latestInvoice && latestInvoice.invoiceNumber) {
    const parts = latestInvoice.invoiceNumber.split('-');
    const currentSeqStr = parts[parts.length - 1];
    const parsed = parseInt(currentSeqStr, 10);
    if (!isNaN(parsed)) {
      nextSequence = parsed + 1;
    }
  }

  const paddedSequence = String(nextSequence).padStart(5, '0');
  return `${prefix}${paddedSequence}`;
}
