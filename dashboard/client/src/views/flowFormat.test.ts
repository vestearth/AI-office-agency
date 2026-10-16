import { describe, expect, it } from 'vitest';
import { formatSpan } from './flowFormat';

describe('formatSpan', () => {
  it('reads minutes, hours, then days', () => {
    expect(formatSpan(0.15)).toBe('9m');
    expect(formatSpan(0)).toBe('1m');
    expect(formatSpan(3.36)).toBe('3.4h');
    expect(formatSpan(47.9)).toBe('47.9h');
    expect(formatSpan(60)).toBe('2.5d');
    expect(formatSpan(null)).toBe('—');
  });
});
