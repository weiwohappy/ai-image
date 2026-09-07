import sharp from 'sharp';
import { AppError } from '../../shared/http/errors.js';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export async function validateImage(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image must be at most 5 MB');
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
    return { bytes: data, width: info.width, height: info.height, contentType: 'image/png' };
  } catch {
    throw new AppError(
      400,
      'INVALID_IMAGE',
      'Use a valid single-frame JPEG, PNG or WebP image up to 40 megapixels',
    );
  }
}
