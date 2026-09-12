import { api, isRealApi } from '@/src/services/api';
import { createGeneration } from '@/src/services/generationFlow';
import type { GenerationInput, ImageRatio, OutputCount, Resolution } from '@/src/types/domain';

interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('输入必须是对象。');
  return input as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空。`);
  return value.trim();
}

export function registerViviaiTools(): () => void {
  const context = typeof document === 'undefined' ? undefined : document.modelContext;
  if (!context?.registerTool) return () => undefined;
  const lifecycle = new AbortController();
  const options = { signal: lifecycle.signal };
  const register = (tool: WebMcpTool) => { try { void Promise.resolve(context.registerTool(tool, options)).catch(() => undefined); } catch { /* Unsupported preview context. */ } };

  register({
    name: 'create_generation',
    title: '创建图片生成任务',
    description: '使用当前 VIVIAI 账户创建一个图片生成任务，并冻结预计积分。',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', minLength: 1 }, modelId: { type: 'string', default: 'nano-banana-2' }, resolution: { type: 'string', enum: ['1K', '2K', '4K'], default: '1K' }, ratio: { type: 'string', default: '1:1' }, count: { type: 'integer', enum: [1, 2, 3, 4], default: 1 } }, required: ['prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(raw) {
      const input = record(raw);
      const payload: GenerationInput = { prompt: stringValue(input.prompt, 'prompt'), modelId: typeof input.modelId === 'string' ? input.modelId : 'nano-banana-2', resolution: (input.resolution ?? '1K') as Resolution, ratio: (input.ratio ?? '1:1') as ImageRatio, count: (input.count ?? 1) as OutputCount, source: 'generation' };
      const { task } = await createGeneration(payload);
      window.dispatchEvent(new CustomEvent('viviai:data-changed'));
      return { taskId: task.id, status: task.status, estimatedCredits: task.estimatedCredits };
    },
  });
  register({
    name: 'start_remix',
    title: '打开爆款复刻工作台',
    description: '打开用户上传参考图的爆款复刻工作台；可选带入平台示例，不会直接创建或计费。',
    inputSchema: { type: 'object', properties: { templateId: { type: 'string', minLength: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(raw) {
      const input = record(raw);
      if (input.templateId === undefined) {
        window.location.hash = '#/remix';
        return { route: '/remix' };
      }
      const templateId = stringValue(input.templateId, 'templateId');
      const template = await api.getTemplate(templateId);
      window.location.hash = `#/remix/${encodeURIComponent(template.id)}`;
      return { templateId: template.id, route: `/remix/${template.id}` };
    },
  });
  if (!isRealApi()) {
    register({
      name: 'reset_demo_data',
      title: '重置演示数据',
      description: '将 VIVIAI 前端 Mock 数据恢复为初始演示状态。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(raw) {
        record(raw);
        await api.resetDemoData();
        window.dispatchEvent(new CustomEvent('viviai:data-reset'));
        return { reset: true };
      },
    });
  }
  return () => lifecycle.abort();
}
