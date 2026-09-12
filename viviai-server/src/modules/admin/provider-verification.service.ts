import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../shared/http/errors.js';
import {
  OpenAICompatibleChatClient,
  OpenAICompatibleImageClient,
} from '../providers/third-party/openai-compatible.js';
import { requirePermission } from './permissions.js';
import type { AdminActor } from './contracts.js';

@Injectable()
export class AdminProviderVerificationService {
  constructor(@Inject(APP_CONFIG) readonly config: AppConfig) {}

  async verify(actor: Pick<AdminActor, 'permissions'>, providerId: string) {
    requirePermission(actor, 'providers.read');
    if (providerId !== 'sub2api') throw new AppError(404, 'ADMIN_NOT_FOUND', 'Provider not found');
    const config = this.config.thirdPartyChat;
    if (!config) {
      return {
        provider: 'sub2api' as const,
        configured: false as const,
        ok: false as const,
        code: 'not_configured' as const,
        message: 'Provider is not configured',
      };
    }
    return {
      provider: 'sub2api' as const,
      configured: true as const,
      ...(await new OpenAICompatibleChatClient(config).verify()),
    };
  }

  async verifyImages(actor: Pick<AdminActor, 'permissions'>, providerId: string) {
    requirePermission(actor, 'providers.read');
    if (providerId !== 'sub2api') throw new AppError(404, 'ADMIN_NOT_FOUND', 'Provider not found');
    const config = this.config.thirdPartyImages;
    if (!config) {
      return {
        provider: 'sub2api' as const,
        configured: false as const,
        ok: false as const,
        code: 'not_configured' as const,
        message: 'Image provider is not configured',
      };
    }
    return {
      provider: 'sub2api' as const,
      configured: true as const,
      ...(await new OpenAICompatibleImageClient(
        config,
        config.models.map((model) => model.modelId),
      ).verify()),
    };
  }
}
