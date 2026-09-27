export const APP_TIME_ZONE = 'Australia/Sydney';
/** First Sydney hour the morning outstanding digest may send. */
export const DIGEST_HOUR = 7;

const dateTime = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', timeZoneName: 'short',
});

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Format absolute timestamps consistently, including Sydney's daylight-saving changes. */
export function formatSydneyDateTime(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return dateTime.format(date);
}

export function sydneyParts(value: Date = new Date()) {
  const parts = calendar.formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

export function sydneyCalendarDate(value: Date = new Date()): string {
  return sydneyParts(value).date;
}

/** True once Sydney local time has reached the morning digest hour, including DST shifts. */
export function isSydneyMorningWindow(value: Date = new Date(), hour = DIGEST_HOUR): boolean {
  return sydneyParts(value).hour >= hour;
}
