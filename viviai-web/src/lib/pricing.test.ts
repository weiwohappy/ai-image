import { describe, expect, it } from 'vitest';

import { estimateCredits } from './pricing';

describe('estimateCredits', () => {
  it('multiplies NanoBanana 2 4K pricing by output count', () => {
    expect(
      estimateCredits({
        modelId: 'nano-banana-2',
        resolution: '4K',
        count: 4,
      }),
    ).toBe(24);
  });

  it('uses the quality-specific G-image 2 matrix', () => {
    expect(
      estimateCredits({
        modelId: 'g-image-2',
        resolution: '2K',
        quality: 'high',
        count: 2,
      }),
    ).toBe(18);
  });

  it('rejects unsupported model parameter combinations', () => {
    expect(() =>
      estimateCredits({
        modelId: 'nano-banana',
        resolution: '4K',
        count: 1,
      }),
    ).toThrow('PARAMETER_UNSUPPORTED');
  });
});
