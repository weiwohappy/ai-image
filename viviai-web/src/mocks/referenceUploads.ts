import type { UploadedReference } from '@/src/types/domain';

// Mock uploads retain the actual file for this browser session, never in localStorage.
const uploads = new Map<string, { file: File; reference: UploadedReference }>();

/**
 * Retains the uploaded file for this browser session, never in localStorage. The server reads the
 * real dimensions out of the bytes; the double cannot, so dimensions default to zero unless a
 * caller that already knows them supplies them.
 */
export function saveReferenceUpload(file: File, width = 0, height = 0): UploadedReference {
  const reference = { id: `remix-upload-${crypto.randomUUID()}`, name: file.name, width, height };
  uploads.set(reference.id, { file, reference });
  return reference;
}

export function hasReferenceUpload(id: string): boolean {
  return uploads.has(id);
}

export function resetReferenceUploads(): void {
  uploads.clear();
}
