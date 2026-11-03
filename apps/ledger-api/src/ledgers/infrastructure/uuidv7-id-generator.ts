import { randomUUIDv7 } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { IIdGenerator } from '../application/ports/id-generator.port.js';

/**
 * Makes UUIDv7 ids (RFC 9562): 48 bits of Unix time in milliseconds, then random bits.
 * Ids are roughly time-ordered, which keeps the primary-key indexes friendly to inserts.
 */
@Injectable()
export class Uuidv7IdGenerator implements IIdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
