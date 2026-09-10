import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../auth.controller.js';
import { AdminSessionGuard, type AdminRequest } from '../session.guard.js';
import { AdminInvitationsService } from './invitations.service.js';
import { AdminMembersService } from './members.service.js';
import { AdminRolesService } from './roles.service.js';
import { AdminPasswordResetService } from './password-reset.service.js';
import { commandSchema, emailSchema, nameSchema, rolesSchema } from './policy.js';
@Controller('admin/team')
@UseGuards(AdminSessionGuard)
export class AdminTeamController {
  constructor(
    @Inject(AdminInvitationsService) readonly invitations: AdminInvitationsService,
    @Inject(AdminMembersService) readonly members: AdminMembersService,
    @Inject(AdminRolesService) readonly roles: AdminRolesService,
    @Inject(AdminPasswordResetService) readonly resets: AdminPasswordResetService,
  ) {}
  @Get('members') membersList(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.members.list(r.admin, q);
  }
  @Get('members/:id') member(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.members.detail(r.admin, parse(z.uuid(), id));
  }
  @Patch('members/:id') memberEdit(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.members.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'edit',
      parse(z.object({ ...commandSchema, displayName: nameSchema }).strict(), body),
    );
  }
  @Put('members/:id/roles') memberRoles(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.members.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'assignRoles',
      parse(z.object({ ...commandSchema, roles: rolesSchema }).strict(), body),
    );
  }
  @Post('members/:id/enable') enable(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.members.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'enable',
      parse(z.object(commandSchema).strict(), body),
    );
  }
  @Post('members/:id/disable') disable(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.members.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'disable',
      parse(z.object(commandSchema).strict(), body),
    );
  }
  @Post('members/:id/password-resets') reset(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.resets.issue(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      parse(z.object(commandSchema).strict(), body),
    );
  }
  @Get('roles') rolesList(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.roles.list(r.admin, q);
  }
  @Get('roles/:key') role(@Req() r: AdminRequest, @Param('key') key: string) {
    return this.roles.detail(r.admin, parse(z.string().min(1).max(64), key));
  }
  @Get('permission-catalog') catalog(@Req() r: AdminRequest) {
    return this.roles.catalog(r.admin);
  }
  @Post('roles') roleCreate(@Req() r: AdminRequest, @Body() body: unknown) {
    return this.roles.create(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(
        z
          .object({
            key: z
              .string()
              .regex(/^custom_[a-z0-9_]+$/)
              .max(64),
            ...roleFields,
            reason: commandSchema.reason,
          })
          .strict(),
        body,
      ),
    );
  }
  @Patch('roles/:key') roleEdit(
    @Req() r: AdminRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.roles.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.string().min(1).max(64), key),
      'edit',
      parse(z.object({ ...commandSchema, ...roleFields }).strict(), body),
    );
  }
  @Delete('roles/:key') roleDelete(
    @Req() r: AdminRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    return this.roles.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.string().min(1).max(64), key),
      'delete',
      parse(z.object(commandSchema).strict(), body),
    );
  }
  @Get('invitations') list(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.invitations.list(r.admin, q);
  }
  @Post('invitations') create(@Req() r: AdminRequest, @Body() body: unknown) {
    return this.invitations.create(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(
        z
          .object({
            email: emailSchema,
            displayName: nameSchema,
            roles: rolesSchema,
            reason: commandSchema.reason,
          })
          .strict(),
        body,
      ),
    );
  }
  @Patch('invitations/:id') edit(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.invitations.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'edit',
      parse(
        z
          .object({
            ...commandSchema,
            displayName: nameSchema.optional(),
            roles: rolesSchema.optional(),
          })
          .strict()
          .refine((v) => v.displayName !== undefined || v.roles !== undefined),
        body,
      ),
    );
  }
  @Post('invitations/:id/rotate') rotate(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.invitations.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'rotate',
      parse(z.object(commandSchema).strict(), body),
    );
  }
  @Post('invitations/:id/revoke') revoke(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.invitations.change(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      parse(z.uuid(), id),
      'revoke',
      parse(z.object(commandSchema).strict(), body),
    );
  }
}
const roleFields = {
  name: nameSchema,
  description: z.string().trim().max(500),
  permissions: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(100)
    .refine((a) => new Set(a).size === a.length)
    .transform((a) => [...a].sort()),
};
