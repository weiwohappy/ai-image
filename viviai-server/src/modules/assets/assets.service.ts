import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Asset } from '../../generated/prisma/client.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import type { ObjectStore } from './object-store.js';
import { validateImage } from './image-validation.js';
export const ASSET_STORE = Symbol('ASSET_STORE');
export type AssetRecord = Asset;
export interface AssetDto {
  id: string;
  name: string;
  width: number;
  height: number;
  status: string;
  previewUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
  source: string;
  favorite: boolean;
  createdAt: string;
  deletedAt: string | null;
}
export function assetDto(asset: AssetRecord): AssetDto {
  const url = `/api/assets/${asset.id}/content`;
  return {
    id: asset.id,
    name: asset.name,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    previewUrl: url,
    imageUrl: url,
    thumbnailUrl: url,
    source: asset.source,
    favorite: asset.favorite,
    createdAt: asset.createdAt.toISOString(),
    deletedAt: asset.deletedAt?.toISOString() ?? null,
  };
}
const missing = () => new AppError(404, 'NOT_FOUND', 'Asset not found');
function requireId(id: string) {
  if (!z.uuid().safeParse(id).success) throw missing();
}
function validName(name: string) {
  const parsed = z.string().trim().min(1).max(200).safeParse(name);
  if (!parsed.success || /[\u0000-\u001f\u007f]/.test(parsed.data))
    throw new AppError(400, 'INVALID_INPUT', 'Asset name is invalid');
  return parsed.data;
}
@Injectable()
export class AssetService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
  ) {}
  async upload(userId: string, bytes: Uint8Array, name: string): Promise<AssetDto> {
    const cleanName = validName(name);
    const image = await validateImage(bytes);
    const id = randomUUID();
    const objectKey = `assets/${userId}/${id}.png`;
    // Object I/O intentionally precedes metadata; no ready row exists on storage failure.
    await this.store.put(objectKey, image.bytes, image.contentType);
    try {
      const asset = await this.db.client.asset.create({
        data: {
          id,
          userId,
          objectKey,
          name: cleanName,
          width: image.width,
          height: image.height,
          byteSize: image.bytes.byteLength,
          contentType: image.contentType,
          sha256: createHash('sha256').update(image.bytes).digest('hex'),
        },
      });
      return assetDto(asset);
    } catch (error) {
      await this.store.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }
  async getOwned(userId: string, assetId: string): Promise<AssetRecord> {
    requireId(assetId);
    const asset = await this.db.client.asset.findFirst({
      where: { id: assetId, userId, deletedAt: null, status: 'ready' },
    });
    if (!asset) throw missing();
    return asset;
  }
  async readOwned(userId: string, assetId: string): Promise<Uint8Array> {
    const asset = await this.getOwned(userId, assetId);
    return this.store.get(asset.objectKey);
  }
  async list(
    userId: string,
    options: { deleted?: boolean; favorite?: boolean } = {},
  ): Promise<AssetDto[]> {
    const records = await this.db.client.asset.findMany({
      where: {
        userId,
        deletedAt: options.deleted ? { gte: new Date(Date.now() - 7 * 86400_000) } : null,
        ...(options.favorite === undefined ? {} : { favorite: options.favorite }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return records.map(assetDto);
  }
  async update(
    userId: string,
    assetId: string,
    patch: { name?: string; favorite?: boolean },
  ): Promise<AssetDto> {
    requireId(assetId);
    const data = {
      ...(patch.name === undefined ? {} : { name: validName(patch.name) }),
      ...(patch.favorite === undefined ? {} : { favorite: patch.favorite }),
    };
    const result = await this.db.client.asset.updateMany({
      where: { id: assetId, userId, deletedAt: null },
      data,
    });
    if (!result.count) throw missing();
    return assetDto(await this.getOwned(userId, assetId));
  }
  async remove(userId: string, assetId: string): Promise<AssetDto> {
    requireId(assetId);
    const records = await this.db.client.asset.updateManyAndReturn({
      where: { id: assetId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!records[0]) throw missing();
    return assetDto(records[0]);
  }
  async restore(userId: string, assetId: string): Promise<AssetDto> {
    requireId(assetId);
    const records = await this.db.client.asset.updateManyAndReturn({
      where: { id: assetId, userId, deletedAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
      data: { deletedAt: null },
    });
    if (!records[0]) throw missing();
    return assetDto(records[0]);
  }
}
