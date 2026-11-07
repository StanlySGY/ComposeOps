import { describe, expect, it } from 'vitest';
import { parseTimestamp, formatTimestamp } from '../src/lib/date-time.js';

describe('API timestamp formatting', () => {
  it('normalizes SQLite UTC, ISO Z, offsets and epoch values to the same instant', () => {
    const epoch = Date.parse('2026-10-01T09:42:00Z');
    for (const input of ['2026-10-01 09:42:00', '2026-10-01T09:42:00.000', '2026-10-01T09:42:00.000Z', '2026-10-01T17:42:00+08:00', epoch]) {
      expect(parseTimestamp(input).getTime()).toBe(epoch);
      expect(formatTimestamp(input)).not.toContain('Invalid Date');
    }
  });
  it('renders unavailable and invalid values safely, preserving epoch zero', () => {
    for (const value of [undefined, null, '', 'invalid']) expect(formatTimestamp(value)).toBe('—');
    expect(parseTimestamp(0).getTime()).toBe(0);
  });
});
