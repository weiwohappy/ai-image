import type { UploadedReference } from '@/src/types/domain';

// Mock uploads retain the actual file for this browser session, never in localStorage.
const uploads = new Map<string, { file: File; reference: UploadedReference }>();

export function saveReferenceUpload(file: File, width: number, height: number): UploadedReference {
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
