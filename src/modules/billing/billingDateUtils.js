/**
 * Billing Date Calculation Utilities
 *
 * Implements calendar-correct date math for subscription intervals:
 * - DAY: Exactly N calendar days added to start date.
 * - MONTHLY: Preserves calendar-day semantics with month-end boundary clamping
 *   (e.g., Jan 31 + 1 month = Feb 28 in normal years or Feb 29 in leap years).
 * - YEARLY: Preserves calendar date with leap-year handling (Feb 29 -> Feb 28 in non-leap year).
 * - ONE_TIME: No recurring renewal or scheduled expiry (returns null).
 *
 * INTERVAL CONVENTION:
 * Half-open interval [startDate, endDate).
 * A subscription is effective at time T if:
 *   T >= startDate AND (endDate === null OR T < endDate).
 */

/**
 * Checks if a given year is a leap year.
 * @param {number} year
 * @returns {boolean}
 */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of days in a specific month of a given year (1-based month).
 * @param {number} year
 * @param {number} month (1 - 12)
 * @returns {number}
 */
export function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calculates the subscription end date based on interval and start date.
 * @param {Date|string} startDate
 * @param {'DAY'|'MONTHLY'|'YEARLY'|'ONE_TIME'} interval
 * @param {number} [intervalCount=1]
 * @returns {Date|null} End date or null for ONE_TIME
 */
export function calculateSubscriptionEndDate(startDate, interval, intervalCount = 1) {
  if (interval === 'ONE_TIME') {
    return null;
  }

  const start = new Date(startDate);
  if (isNaN(start.getTime())) {
    throw new Error(`Invalid startDate provided: ${startDate}`);
  }

  const count = Math.max(1, parseInt(intervalCount, 10) || 1);

  if (interval === 'DAY') {
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + count);
    return end;
  }

  if (interval === 'MONTHLY') {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth(); // 0-based
    const day = start.getUTCDate();
    const hours = start.getUTCHours();
    const minutes = start.getUTCMinutes();
    const seconds = start.getUTCSeconds();
    const ms = start.getUTCMilliseconds();

    // Compute target month and year
    const totalMonths = month + count;
    const targetYear = year + Math.floor(totalMonths / 12);
    const targetMonth = (totalMonths % 12 + 12) % 12; // 0-based

    // Clamp day to maximum days in target month (1-based: targetMonth + 1)
    const maxDays = getDaysInMonth(targetYear, targetMonth + 1);
    const targetDay = Math.min(day, maxDays);

    return new Date(Date.UTC(targetYear, targetMonth, targetDay, hours, minutes, seconds, ms));
  }

  if (interval === 'YEARLY') {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth();
    const day = start.getUTCDate();
    const hours = start.getUTCHours();
    const minutes = start.getUTCMinutes();
    const seconds = start.getUTCSeconds();
    const ms = start.getUTCMilliseconds();

    const targetYear = year + count;
    const maxDays = getDaysInMonth(targetYear, month + 1);
    const targetDay = Math.min(day, maxDays);

    return new Date(Date.UTC(targetYear, month, targetDay, hours, minutes, seconds, ms));
  }

  throw new Error(`Unsupported billing interval: "${interval}"`);
}

/**
 * Calculates next billing date for recurring subscriptions.
 * For ONE_TIME, returns null.
 * @param {Date|string} startDate
 * @param {'DAY'|'MONTHLY'|'YEARLY'|'ONE_TIME'} interval
 * @param {number} [intervalCount=1]
 * @returns {Date|null}
 */
export function calculateNextBillingDate(startDate, interval, intervalCount = 1) {
  return calculateSubscriptionEndDate(startDate, interval, intervalCount);
}

/**
 * Validates whether a subscription is currently active given its temporal boundary.
 * Convention: [startDate, endDate)
 * @param {Date|string} startDate
 * @param {Date|string|null} endDate
 * @param {Date|string} [now=new Date()]
 * @returns {boolean}
 */
export function isSubscriptionWithinValidity(startDate, endDate, now = new Date()) {
  const current = new Date(now);
  const start = new Date(startDate);
  if (current < start) {
    return false; // Future subscription not yet started
  }
  if (!endDate) {
    return true; // ONE_TIME or open-ended lifetime
  }
  const end = new Date(endDate);
  return current < end;
}
