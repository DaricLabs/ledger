import { Module } from '@nestjs/common';
import { ID_GENERATOR } from './application/ports/id-generator.port.js';
import { Uuidv7IdGenerator } from './infrastructure/uuidv7-id-generator.js';

/**
 * Makes ids for new rows. A feature imports this module and injects
 * `ID_GENERATOR`. It depends on no feature and on nothing else in the app.
 */
@Module({
  providers: [{ provide: ID_GENERATOR, useClass: Uuidv7IdGenerator }],
  exports: [ID_GENERATOR],
})
export class IdsModule {}
