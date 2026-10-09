import { Controller, HttpCode, Inject, NotFoundException, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { fromEdge } from '../common/edge';
import { Public } from '../common/http';
import { CONFIG, type Config } from '../config/config';
import { HousekeepingService } from './housekeeping.service';

/**
 * For the proxy's own scheduled calls: a clock that runs while the service is scaled to zero.
 * These paths exist only when EDGE_SECRET is set, since without one there is no telling the proxy
 * from anyone else; the proxy never forwards a visitor's request to them.
 */
@Public()
@SkipThrottle()
@Controller('internal')
export class InternalController {
  constructor(private readonly housekeeping: HousekeepingService, @Inject(CONFIG) private readonly config: Config) {}

  @Post('housekeeping')
  @HttpCode(200)
  run(@Req() req: Request) {
    if (!this.config.EDGE_SECRET || !fromEdge(this.config, req.headers)) throw new NotFoundException();
    return this.housekeeping.run();
  }
}
