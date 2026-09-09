import sharp from 'sharp';
import { AppError } from '../../shared/http/errors.js';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_GENERATED_IMAGE_BYTES = 96 * 1024 * 1024;
export async function validateImage(bytes: Uint8Array, maxBytes = MAX_IMAGE_BYTES) {
  if (bytes.byteLength > maxBytes)
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image exceeds permitted size');
  try {
    const input = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'warning',
      animated: true,
    });
    const meta = await input.metadata();
    if (
      !meta.format ||
      !['jpeg', 'png', 'webp'].includes(meta.format) ||
      (meta.pages ?? 1) !== 1 ||
      !meta.width ||
      !meta.height ||
      meta.width * meta.height > MAX_IMAGE_PIXELS
    )
      throw new Error('Invalid raster');
    // Rotate before stripping metadata; dimensions reflect displayed orientation.
    const { data, info } = await input.rotate().png().toBuffer({ resolveWithObject: true });
    if (data.byteLength > maxBytes) throw new Error('Normalized image too large');
    return { bytes: data, width: info.width, height: info.height, contentType: 'image/png' };
  } catch {
    throw new AppError(
      400,
      'INVALID_IMAGE',
      'Use a valid single-frame JPEG, PNG or WebP image up to 40 megapixels',
    );
  }
}
