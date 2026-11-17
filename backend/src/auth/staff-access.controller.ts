import { BadRequestException, Body, Controller, Get, Header, HttpException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthSessionGuard } from './auth-session.guard.js';
import { RolesGuard } from './roles.guard.js';
import { Roles } from './roles.decorator.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './authenticated-user.js';
import { StaffAccessService } from './staff-access.service.js';
import { assignStaffSchema, listStaffSchema, provisionStaffSchema, staffUserIdSchema, staffCandidateSchema, createStaffSchema } from './staff-access.schema.js';

function userId(value: string) {
  const parsed = staffUserIdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid user identifier.');
  return parsed.data;
}

@Controller('api/admin/staff')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('admin')
export class StaffAccessController {
  constructor(private readonly staff: StaffAccessService) {}

  @Get('requests')
  @Header('Cache-Control', 'no-store')
  requests(@CurrentUser() actor: AuthenticatedUser) { return this.staff.pendingRegistrations(actor); }

  @Post('requests/:staffId/approve')
  @Header('Cache-Control', 'no-store')
  approve(@CurrentUser() actor: AuthenticatedUser, @Param('staffId') staffId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Provide an empty body.');
    return this.staff.approveRegistration(actor, userId(staffId));
  }

  @Post('accounts')
  @Header('Cache-Control', 'no-store')
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createStaffSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Provide a name, valid email and password of 8–128 characters.');
    return this.staff.create(actor, parsed.data);
  }

  @Get('candidate')
  @Header('Cache-Control', 'no-store')
  candidate(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) {
    const parsed = staffCandidateSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Provide one valid account email.');
    return this.staff.candidate(actor, parsed.data.email);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) {
    const parsed = listStaffSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid pagination.');
    return this.staff.listStaff(actor, parsed.data.limit, parsed.data.offset);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  provision(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = provisionStaffSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Confirm a valid account identifier to provision staff.');
    return this.staff.provision(actor, parsed.data.userId);
  }

  @Get(':staffId/assignments')
  @Header('Cache-Control', 'no-store')
  assignments(@CurrentUser() actor: AuthenticatedUser, @Param('staffId') staffId: string) {
    return this.staff.listAssignments(actor, userId(staffId));
  }

  @Post(':staffId/assignments')
  @Header('Cache-Control', 'no-store')
  assign(@CurrentUser() actor: AuthenticatedUser, @Param('staffId') staffId: string, @Body() body: unknown) {
    const parsed = assignStaffSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Provide one doctor user identifier.');
    return this.staff.assign(actor, userId(staffId), parsed.data.doctorId);
  }

  @Post(':staffId/assignments/:doctorId/revoke')
  @Header('Cache-Control', 'no-store')
  revoke(@CurrentUser() actor: AuthenticatedUser, @Param('staffId') staffId: string, @Param('doctorId') doctorId: string) {
    return this.staff.revoke(actor, userId(staffId), userId(doctorId));
  }
}

@Controller('api/staff-registration')
export class StaffRegistrationController {
  private readonly attempts = new Map<string, { count: number; reset: number }>();
  constructor(private readonly staff: StaffAccessService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  register(@Req() request: Request, @Body() body: unknown) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.reset <= now) this.attempts.delete(key);
    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const value = this.attempts.get(key) ?? { count: 0, reset: now + 600000 };
    if (value.count >= 5 || !this.attempts.has(key) && this.attempts.size >= 1000) throw new HttpException('Too many registration attempts. Try again later.', 429);
    value.count++; this.attempts.set(key, value);
    const parsed = createStaffSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Provide a name, valid email and password of 8–128 characters.');
    return this.staff.register(parsed.data);
  }

  @Get('me')
  @UseGuards(AuthSessionGuard, RolesGuard)
  @Roles('staff')
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() actor: AuthenticatedUser) { return this.staff.registrationStatus(actor); }
}
