import {
  Body,
  Controller,
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
import { MAX_IMAGE_BYTES } from '../../assets/image-validation.js';
import { AppError } from '../../../shared/http/errors.js';
import { parse } from '../auth.controller.js';
import { AdminSessionGuard, type AdminRequest } from '../session.guard.js';
import { AdminContentService, type ContentKind } from './content.service.js';
import { AdminContentMediaService } from './media.service.js';

@Controller('admin/content')
@UseGuards(AdminSessionGuard)
export class AdminContentController {
  constructor(
    @Inject(AdminContentService) private readonly content: AdminContentService,
    @Inject(AdminContentMediaService) private readonly media: AdminContentMediaService,
  ) {}

  @Get('media')
  mediaList(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.media.list(request.admin, query);
  }

  @Post('media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES + 1 } }))
  upload(
    @Req() request: AdminRequest,
    @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    if (!file) throw new AppError(400, 'INVALID_IMAGE', 'Image file required');
    const fields = parse(z.object({ reason: z.string().trim().min(5).max(500) }).strict(), body);
    return this.media.upload(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      file.buffer,
      file.originalname,
      file.mimetype,
      fields.reason,
    );
  }

  @Get('media/:id')
  mediaMeta(@Req() request: AdminRequest, @Param('id') id: string, @Query() query: unknown) {
    parse(z.object({}).strict(), query);
    return this.media.metadata(request.admin, id);
  }

  @Get('media/:id/content')
  async preview(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() response: Response,
  ) {
    parse(z.object({}).strict(), query);
    const { row, bytes } = await this.media.read(request.admin, id);
    const etag = `"${row.sha256}"`;
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', row.contentType);
    response.setHeader('ETag', etag);
    response.setHeader('Content-Length', row.byteSize);
    if (request.get('If-None-Match') === etag) {
      response.status(304).end();
      return;
    }
    response.send(Buffer.from(bytes));
  }

  @Post('media/:id/transition')
  mediaTransition(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.media.transition(request.admin, request.get('Idempotency-Key') ?? '', id, body);
  }

  @Post('media/:id/archive')
  mediaArchive(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.media.archive(request.admin, request.get('Idempotency-Key') ?? '', id, body);
  }

  @Get(':kind')
  list(@Req() request: AdminRequest, @Param('kind') kind: string, @Query() query: unknown) {
    return this.content.list(request.admin, this.kind(kind), query);
  }

  @Get(':kind/:id')
  detail(
    @Req() request: AdminRequest,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    parse(z.object({}).strict(), query);
    return this.content.detail(request.admin, this.kind(kind), id);
  }

  @Post(':kind')
  create(@Req() request: AdminRequest, @Param('kind') kind: string, @Body() body: unknown) {
    return this.content.create(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      this.kind(kind),
      body,
    );
  }

  @Patch(':kind/:id')
  update(
    @Req() request: AdminRequest,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.content.update(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      this.kind(kind),
      id,
      body,
    );
  }

  @Post(':kind/reorder')
  reorder(@Req() request: AdminRequest, @Param('kind') kind: string, @Body() body: unknown) {
    return this.content.reorder(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      this.kind(kind),
      body,
    );
  }

  @Post(':kind/:id/transition')
  transition(
    @Req() request: AdminRequest,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.content.transition(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      this.kind(kind),
      id,
      body,
    );
  }

  @Post(':kind/:id/archive')
  archive(
    @Req() request: AdminRequest,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.content.archive(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      this.kind(kind),
      id,
      body,
    );
  }

  private kind(kind: string): ContentKind {
    if (!['inspirations', 'remix-templates', 'tools'].includes(kind))
      throw new AppError(404, 'CONTENT_NOT_FOUND', 'Content type not found');
    return kind as ContentKind;
  }
}
