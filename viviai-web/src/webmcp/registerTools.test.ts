import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerViviaiTools } from './registerTools';

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
});

describe('WebMCP registration', () => {
  it('registers only the two narrow product actions', () => {
    const registerTool = vi.fn();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool } });
    const dispose = registerViviaiTools();

    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(['create_generation', 'start_remix']);
    expect(registerTool.mock.calls[0][0].inputSchema.additionalProperties).toBe(false);
    dispose();
  });
});
