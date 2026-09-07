import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { parseInput } from '../identity/identity.controller.js';
import { AppError } from '../../shared/http/errors.js';
import { AssetService, assetDto } from './assets.service.js';
import { MAX_IMAGE_BYTES } from './image-validation.js';
@UseGuards(SessionGuard)
@Controller()
export class AssetsController {
  constructor(@Inject(AssetService) private readonly assets: AssetService) {}
  @Post('remix-references')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5, fieldSize: 1024 },
    }),
  )
  upload(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: { buffer: Buffer; originalname: string },
  ) {
    if (!file) throw new AppError(400, 'INVALID_IMAGE', 'An image file is required');
    return this.assets.upload(req.userId, file.buffer, file.originalname);
  }
  @Get('assets')
  list(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const input = parseInput(
      z.object({
        deleted: z.enum(['true', 'false']).optional(),
        favorite: z.enum(['true', 'false']).optional(),
      }),
      query,
    );
    return this.assets.list(req.userId, {
      ...(input.deleted === undefined ? {} : { deleted: input.deleted === 'true' }),
      ...(input.favorite === undefined ? {} : { favorite: input.favorite === 'true' }),
    });
  }
  @Get('assets/:id')
  async detail(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return assetDto(await this.assets.getOwned(req.userId, id));
  }
  @Get('assets/:id/content')
  async content(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const asset = await this.assets.getOwned(req.userId, id);
    const bytes = await this.assets.readOwned(req.userId, id);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', 'inline');
    response.type(asset.contentType).send(Buffer.from(bytes));
  }
  @Patch('assets/:id')
  update(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(
      z.object({ name: z.string().optional(), favorite: z.boolean().optional() }).strict(),
      body,
    );
    return this.assets.update(req.userId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
    });
  }
  @Delete('assets/:id')
  remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.assets.remove(req.userId, id);
  }
  @Post('assets/:id/restore')
  restore(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.assets.restore(req.userId, id);
  }
}
