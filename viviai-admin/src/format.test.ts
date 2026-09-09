import { describe, it, expect } from 'vitest';
import { formatValue, safeRoute } from './format';
describe('lossless display', () => {
  it('formats minor units and micros without floating point loss', () => {
    expect(formatValue('900719925474099399', 'cny')).toBe('¥9,007,199,254,740,993.99');
    expect(formatValue('39001', 'usd')).toBe('$0.039001');
    expect(formatValue('-101', 'cny')).toBe('-¥1.01');
  });
  it('distinguishes unavailable from a true zero', () => {
    expect(formatValue(null, 'cny')).toBe('暂不可用');
    expect(formatValue('0', 'cny')).toBe('¥0.00');
  });
  it('does not allow external or unknown navigation', () => {
    expect(safeRoute('/jobs/j-1')).toBe('/jobs/j-1');
    expect(safeRoute('/models/gemini-3.1-flash-image-preview')).toBe(
      '/models/gemini-3.1-flash-image-preview',
    );
    for (const path of ['https://bad.test', '//bad.test', '/auth/logout', '/jobs/../users'])
      expect(safeRoute(path)).toBeNull();
  });
});
