import type { EstimateCreditsInput } from '@/src/types/domain';

const simplePricing: Record<string, Partial<Record<EstimateCreditsInput['resolution'], number>>> = {
  'nano-banana-2': { '1K': 4, '2K': 5, '4K': 6 },
  'nano-banana-pro': { '1K': 6 },
  'nano-banana-2-lite': { '1K': 4 },
  'nano-banana': { '1K': 3 },
};

const gImagePricing: Partial<
  Record<NonNullable<EstimateCreditsInput['quality']>, Partial<Record<EstimateCreditsInput['resolution'], number>>>
> = {
  high: { '1K': 5, '2K': 9, '4K': 11 },
  medium: { '1K': 4 },
  low: { '1K': 4, '2K': 8 },
};

export function estimateCredits(input: EstimateCreditsInput): number {
  const unitPrice =
    input.modelId === 'g-image-2'
      ? gImagePricing[input.quality ?? 'high']?.[input.resolution]
      : simplePricing[input.modelId]?.[input.resolution];

  if (unitPrice === undefined) {
    throw new Error('PARAMETER_UNSUPPORTED');
  }

  return unitPrice * input.count;
}
