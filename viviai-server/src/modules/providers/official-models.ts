// Verified 2026-09-09: ai.google.dev/gemini-api/docs/image-generation,
// .../models/gemini-3.1-flash-lite-image and OpenAI image-generation guide.
// Product presets are a reviewed subset, never a Cartesian product of enums.
export const OFFICIAL_MODELS = [
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana', provider: 'google', maxImages: 2 },
  {
    id: 'gemini-3.1-flash-lite-image',
    name: 'Nano Banana 2 Lite',
    provider: 'google',
    maxImages: 1,
  },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2', provider: 'google', maxImages: 2 },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro', provider: 'google', maxImages: 2 },
  { id: 'gpt-image-2', name: 'GPT Image 2', provider: 'openai', maxImages: 2 },
] as const;
export type OfficialModelId = (typeof OFFICIAL_MODELS)[number]['id'];
export interface OfficialOutputSpec {
  id: string;
  resolution: string;
  ratio: string;
  width: number;
  height: number;
  imageSize?: string;
}
type Row = readonly [ratio: string, ...dimensions: string[]];
const googleRows: Row[] = [
  ['1:1', '512x512', '1024x1024', '2048x2048', '4096x4096'],
  ['2:3', '424x632', '848x1264', '1696x2528', '3392x5056'],
  ['3:2', '632x424', '1264x848', '2528x1696', '5056x3392'],
  ['3:4', '448x600', '896x1200', '1792x2400', '3584x4800'],
  ['4:3', '600x448', '1200x896', '2400x1792', '4800x3584'],
  ['4:5', '464x576', '928x1152', '1856x2304', '3712x4608'],
  ['5:4', '576x464', '1152x928', '2304x1856', '4608x3712'],
  ['9:16', '384x688', '768x1376', '1536x2752', '3072x5504'],
  ['16:9', '688x384', '1376x768', '2752x1536', '5504x3072'],
  ['21:9', '792x168', '1584x672', '3168x1344', '6336x2688'],
];
const legacyRows: Row[] = [
  ['1:1', '1024x1024'],
  ['2:3', '832x1248'],
  ['3:2', '1248x832'],
  ['3:4', '864x1184'],
  ['4:3', '1184x864'],
  ['4:5', '896x1152'],
  ['5:4', '1152x896'],
  ['9:16', '768x1344'],
  ['16:9', '1344x768'],
  ['21:9', '1536x672'],
];
// OpenAI publishes flexible-size constraints, not Google's named resolution tables.
// These explicit product presets satisfy div16, aspect <=3, edge<=3840,
// pixels 655360..8294400; 4K square is intentionally absent.
const openaiRows: Row[] = [
  ['1:1', '1024x1024', '2048x2048'],
  ['2:3', '1024x1536', '1536x2304'],
  ['3:2', '1536x1024', '2304x1536'],
  ['3:4', '768x1024', '1536x2048'],
  ['4:3', '1024x768', '2048x1536'],
  ['4:5', '1024x1280', '1536x1920'],
  ['5:4', '1280x1024', '1920x1536'],
  ['9:16', '864x1536', '1152x2048', '2160x3840'],
  ['16:9', '1536x864', '2048x1152', '3840x2160'],
  ['21:9', '1792x768', '2688x1152'],
];
function spec(
  resolution: string,
  ratio: string,
  dimensions: string,
  imageSize?: string,
): OfficialOutputSpec {
  const [width, height] = dimensions.split('x').map(Number) as [number, number];
  return {
    id: `png-${resolution.toLowerCase().replace('.', '_')}-${ratio.replace(':', 'x')}-v1`,
    resolution,
    ratio,
    width,
    height,
    ...(imageSize ? { imageSize } : {}),
  };
}
export function officialSpecs(modelId: string): OfficialOutputSpec[] {
  if (modelId === 'gemini-3.1-flash-lite-image')
    // Official Lite page confirms 1K square; exact non-square pixel table is absent.
    // Model page says 1024px; Interactions enum says 1K. Omit optional size
    // for this fixed-1K model until live verification resolves the doc mismatch.
    return [spec('1K', '1:1', '1024x1024')];
  if (modelId === 'gemini-2.5-flash-image')
    return legacyRows.map(([ratio, size]) => spec('1K', ratio, size!));
  if (modelId === 'gpt-image-2')
    return openaiRows.flatMap(([ratio, ...sizes]) =>
      sizes.map((size, i) => spec(['1K', '2K', '4K'][i]!, ratio, size)),
    );
  if (modelId === 'gemini-3.1-flash-image' || modelId === 'gemini-3-pro-image')
    return googleRows.flatMap(([ratio, ...sizes]) =>
      sizes.flatMap((size, i) =>
        i === 0 && modelId === 'gemini-3-pro-image'
          ? []
          : [spec(['0.5K', '1K', '2K', '4K'][i]!, ratio, size, ['512', '1K', '2K', '4K'][i])],
      ),
    );
  return [];
}
export function getOfficialOutputSpec(modelId: string, outputSpecId: string) {
  return officialSpecs(modelId).find((spec) => spec.id === outputSpecId);
}
