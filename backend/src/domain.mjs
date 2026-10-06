export const APPOINTMENT_STATUSES = Object.freeze([
  'BOOKED',
  'CONFIRMED',
  'CHECKED_IN',
  'WAITING',
  'CALLED',
  'IN_SERVICE',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW'
]);

export function estimateWaitTime(queueEntries, averageServiceTime) {
  const peopleAhead = queueEntries.filter((entry) =>
    ['WAITING', 'CHECKED_IN', 'CALLED', 'IN_SERVICE'].includes(entry.status)
  ).length;
  return {
    peopleAhead,
    estimatedWaitMinutes: peopleAhead * averageServiceTime
  };
}

export function createToken(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('Queue sequence must be a positive integer.');
  }
  return `A${String(sequence).padStart(3, '0')}`;
}

export function getHttpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
