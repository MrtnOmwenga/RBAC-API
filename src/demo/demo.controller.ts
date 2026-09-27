import { Controller, Inject, NotFoundException, Post } from '@nestjs/common';
import { Public } from '../common/http';
import { CONFIG, type Config } from '../config/config';
import { DemoService } from './demo.service';

@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService, @Inject(CONFIG) private readonly config: Config) {}

  /** A private agency with the demo cast and briefing, and a token for each character. */
  @Public()
  @Post('sessions')
  create() {
    if (!this.config.DEMO_MODE) throw new NotFoundException();
    return this.demo.create();
  }
}
