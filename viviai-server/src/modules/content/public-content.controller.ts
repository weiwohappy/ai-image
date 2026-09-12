import {
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../identity/identity.controller.js';
import {
  OptionalSessionGuard,
  type OptionalSessionRequest,
} from '../identity/optional-session.guard.js';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { PublicContentService } from './public-content.service.js';

const externalIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,159}$/);
const mediaPathIdSchema = z.string().regex(/^[A-Za-z0-9-]{2,160}$/);
const filterValue = z.string().trim().min(1).max(160);
const pageShape = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d?$/)
    .transform(Number)
    .refine((value) => value <= 50)
    .optional(),
};

@Controller()
export class PublicContentController {
  constructor(@Inject(PublicContentService) private readonly content: PublicContentService) {}

  @Get('inspirations')
  @UseGuards(OptionalSessionGuard)
  inspirations(
    @Req() request: OptionalSessionRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    setPersonalizedCacheHeaders(response);
    const input = parseInput(
      z.object({ ...pageShape, category: filterValue.optional() }).strict(),
      query,
    );
    return this.content.listInspirations(
      {
        limit: input.limit ?? 50,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.category ? { category: input.category } : {}),
      },
      request.userId,
    );
  }

  @Post('inspirations/:id/like')
  @UseGuards(SessionGuard)
  like(@Req() request: AuthenticatedRequest, @Param('id') rawId: string) {
    return this.content.likeInspiration(request.userId, parseInput(externalIdSchema, rawId));
  }

  @Delete('inspirations/:id/like')
  @UseGuards(SessionGuard)
  unlike(@Req() request: AuthenticatedRequest, @Param('id') rawId: string) {
    return this.content.unlikeInspiration(request.userId, parseInput(externalIdSchema, rawId));
  }

  @Get('remix-templates')
  @UseGuards(OptionalSessionGuard)
  remixTemplates(
    @Req() request: OptionalSessionRequest,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    setPersonalizedCacheHeaders(response);
    const input = parseInput(
      z
        .object({
          ...pageShape,
          category: filterValue.optional(),
          platform: filterValue.optional(),
          industry: filterValue.optional(),
          style: filterValue.optional(),
        })
        .strict(),
      query,
    );
    return this.content.listRemixTemplates(
      {
        limit: input.limit ?? 50,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.industry ? { industry: input.industry } : {}),
        ...(input.style ? { style: input.style } : {}),
      },
      request.userId,
    );
  }

  @Get('remix-templates/:id')
  @UseGuards(OptionalSessionGuard)
  remixTemplate(
    @Req() request: OptionalSessionRequest,
    @Param('id') rawId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    setPersonalizedCacheHeaders(response);
    return this.content.remixTemplate(parseInput(externalIdSchema, rawId), request.userId);
  }

  @Post('remix-templates/:id/favorite')
  @UseGuards(SessionGuard)
  favorite(@Req() request: AuthenticatedRequest, @Param('id') rawId: string) {
    return this.content.favoriteTemplate(request.userId, parseInput(externalIdSchema, rawId));
  }

  @Delete('remix-templates/:id/favorite')
  @UseGuards(SessionGuard)
  unfavorite(@Req() request: AuthenticatedRequest, @Param('id') rawId: string) {
    return this.content.unfavoriteTemplate(request.userId, parseInput(externalIdSchema, rawId));
  }

  @Get('tools')
  @UseGuards(OptionalSessionGuard)
  tools(@Query() query: unknown) {
    const input = parseInput(
      z.object({ ...pageShape, category: filterValue.optional() }).strict(),
      query,
    );
    return this.content.listTools({
      limit: input.limit ?? 50,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.category ? { category: input.category } : {}),
    });
  }

  @Get('tools/:id')
  @UseGuards(OptionalSessionGuard)
  tool(@Param('id') rawId: string) {
    return this.content.tool(parseInput(externalIdSchema, rawId));
  }

  @Get('content-media/:id/content')
  async media(
    @Param('id') rawId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() response: Response,
  ) {
    const media = await this.content.media(parseInput(mediaPathIdSchema, rawId));
    response.setHeader('Content-Type', media.contentType);
    response.setHeader('Content-Length', media.byteSize);
    response.setHeader('ETag', media.etag);
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    response.setHeader('Content-Disposition', 'inline');
    if (matchesEtag(ifNoneMatch, media.etag)) {
      response.status(304).end();
      return;
    }
    response.status(200).send(Buffer.from(media.bytes));
  }
}

function setPersonalizedCacheHeaders(response: Response): void {
  response.setHeader('Cache-Control', 'private, no-store');
  response.vary('Cookie');
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag || value === `W/${etag}`);
}
