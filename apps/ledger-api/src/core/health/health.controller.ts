import { Controller, Get } from '@nestjs/common';
import type { HealthResponseDto } from './health-response.dto.js';

@Controller('health')
export class HealthController {
  /**
   * Liveness check: answers "is the process running?".
   * It does not touch the database on purpose, so a database outage
   * does not make an orchestrator restart a healthy process.
   */
  @Get()
  check(): HealthResponseDto {
    return { status: 'ok' };
  }
}
