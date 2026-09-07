import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { CatalogService } from './catalog.service.js';
@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get('models') models() {
    return this.catalog.models();
  }
  @Post('generation-quotes')
  @UseGuards(SessionGuard)
  quote(@Req() request: AuthenticatedRequest, @Body() input: unknown) {
    return this.catalog.quote(request.userId, input);
  }
}
