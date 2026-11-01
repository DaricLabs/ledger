/**
 * Creates the ids of new rows.
 *
 * The use case asks for an id and passes it into the domain, so the domain
 * and its tests stay deterministic.
 */
export interface IIdGenerator {
  /** Returns a new UUIDv7 as a lowercase string. */
  next(): string;
}

/** Nest DI token for {@link IIdGenerator}. */
export const ID_GENERATOR = Symbol('ID_GENERATOR');
