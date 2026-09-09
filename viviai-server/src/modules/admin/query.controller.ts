import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AdminSessionGuard, type AdminRequest } from './session.guard.js';
import { AdminQueryService } from './query.service.js';
@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminQueryController {
  constructor(@Inject(AdminQueryService) private readonly queries: AdminQueryService) {}
  @Get('dashboard') dashboard(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.dashboard(r.admin.actor, q);
  }
  @Get('users') users(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.users(r.admin.actor, q);
  }
  @Get('users/:id') user(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.queries.user(r.admin.actor, id);
  }
  @Get('users/:id/credit-lots') lots(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.queries.creditLots(r.admin.actor, id, q);
  }
  @Get('users/:id/credit-events') events(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.queries.creditEvents(r.admin.actor, id, q);
  }
  @Get('orders') orders(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.orders(r.admin.actor, q);
  }
  @Get('orders/:id') order(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.queries.order(r.admin.actor, id);
  }
  @Get('jobs') jobs(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.jobs(r.admin.actor, q);
  }
  @Get('jobs/:id') job(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.queries.job(r.admin.actor, id);
  }
  @Get('attempts/:id') attempt(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.queries.attempt(r.admin.actor, id);
  }
  @Get('models') models(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.models(r.admin.actor, q);
  }
  @Get('models/:id') model(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.queries.model(r.admin.actor, id);
  }
  @Get('provider-accounts') providers(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.providers(r.admin.actor, q);
  }
  @Get('alerts') alerts(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.alerts(r.admin.actor, q);
  }
  @Get('audit-events') audit(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.auditEvents(r.admin.actor, q);
  }
  @Get('administrators') admins(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.administrators(r.admin.actor, q);
  }
  @Get('roles') roles(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.queries.roles(r.admin.actor, q);
  }
}
