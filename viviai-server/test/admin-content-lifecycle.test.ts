import { describe, expect, it } from 'vitest';
import { canTransitionContent } from '../src/modules/admin/content/content.service.js';

describe('admin content lifecycle', () => {
  it('allows only the approved forward lifecycle transitions', () => {
    expect(canTransitionContent('draft', 'published')).toBe(true);
    expect(canTransitionContent('draft', 'archived')).toBe(true);
    expect(canTransitionContent('published', 'offline')).toBe(true);
    expect(canTransitionContent('offline', 'published')).toBe(true);
    expect(canTransitionContent('offline', 'archived')).toBe(true);
    expect(canTransitionContent('published', 'archived')).toBe(false);
    expect(canTransitionContent('archived', 'published')).toBe(false);
  });
});
