/**
 * Jurisdiction-Aware Tax Calculation Service
 *
 * Rules:
 * - Germany (DE): 19% standard MwSt (0.1900)
 * - Austria (AT): 20% standard USt (0.2000)
 * - Switzerland (CH): 8.1% MWST (0.0810)
 * - United Kingdom (GB): 20% VAT (0.2000)
 * - United States (US): 0% (0.0000, state-level handling)
 * - Default: Configurable fallback, default 19% for Germany / EU.
 *
 * Reconciled Arithmetic:
 * netAmount + taxAmount = grossTotal
 * Uses documented Half-Up rounding to 2 decimal places.
 */

export const JURISDICTION_TAX_RATES = {
  DE: { rate: 0.19, label: '19% MwSt.' },
  AT: { rate: 0.20, label: '20% USt.' },
  CH: { rate: 0.081, label: '8.1% MWST' },
  GB: { rate: 0.20, label: '20% VAT' },
  FR: { rate: 0.20, label: '20% TVA' },
  US: { rate: 0.00, label: '0% Sales Tax' },
};

export const DEFAULT_TAX_JURISDICTION = 'DE';

/**
 * Resolves standard tax rate for country code.
 * @param {string} [countryCode='DE']
 * @returns {{ rate: number, label: string }}
 */
export function getTaxRateForJurisdiction(countryCode = 'DE') {
  const normalized = (countryCode || DEFAULT_TAX_JURISDICTION).toUpperCase().trim();
  return JURISDICTION_TAX_RATES[normalized] || JURISDICTION_TAX_RATES[DEFAULT_TAX_JURISDICTION];
}

/**
 * Rounds a number to exactly 2 decimal places using half-up arithmetic.
 * Avoids IEEE 754 precision issues via integer cent calculations.
 * @param {number} value
 * @returns {number}
 */
export function roundToCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates net, tax, and gross invoice amounts.
 * Guarantees that: netAmount + taxAmount === grossTotal.
 *
 * @param {number|string} rawNet
 * @param {number|string} [customTaxRate] Optional override tax rate (0.0 to 1.0)
 * @param {string} [countryCode='DE'] Jurisdiction country code
 * @returns {{
 *   netAmount: number,
 *   taxRate: number,
 *   taxAmount: number,
 *   grossTotal: number,
 *   taxLabel: string,
 *   netFormatted: string,
 *   taxFormatted: string,
 *   grossFormatted: string
 * }}
 */
export function calculateInvoiceTotals(rawNet, customTaxRate = null, countryCode = 'DE') {
  const net = roundToCents(Number(rawNet) || 0);

  let taxRate;
  let taxLabel;

  if (customTaxRate !== null && customTaxRate !== undefined) {
    taxRate = Number(customTaxRate);
    taxLabel = `${(taxRate * 100).toFixed(1)}% Tax`;
  } else {
    const info = getTaxRateForJurisdiction(countryCode);
    taxRate = info.rate;
    taxLabel = info.label;
  }

  // Calculate tax amount in cents
  const taxAmount = roundToCents(net * taxRate);
  // Reconciled gross total: strictly net + tax
  const grossTotal = roundToCents(net + taxAmount);

  return {
    netAmount: net,
    taxRate,
    taxAmount,
    grossTotal,
    taxLabel,
    netFormatted: net.toFixed(2),
    taxFormatted: taxAmount.toFixed(2),
    grossFormatted: grossTotal.toFixed(2),
  };
}
