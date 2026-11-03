/**
 * Base class of every error that business code raises on purpose, in any
 * feature or app (a rule was broken, something was not found, and so on).
 *
 * Each error must have a `code`. A code is a stable name for the problem that
 * code outside the domain can switch on (an HTTP API, an event consumer, a
 * CLI), so nobody has to compare messages or class names.
 *
 * The code is part of the public API: add new ones freely, never rename or
 * remove. Do not use a number or a transport word (like an HTTP status) in it.
 * How an error is shown, for example its HTTP status, is decided by the
 * outer layers, not here.
 *
 * `name` is filled in automatically from the concrete class that was
 * instantiated, so subclasses do not set it themselves. It is what shows up
 * in stack traces and logs. It is not a substitute for `code`: use `code`
 * for anything that must stay stable, because a class name can change when
 * code is minified or renamed.
 *
 * Do not throw this class directly (it is abstract). Features add their own
 * base class on top, so code can catch the errors of one feature only.
 *
 * @example
 * ```ts
 * export class LedgerAlreadyExistsError extends LedgerDomainError {
 *   readonly code = 'LEDGER_ALREADY_EXISTS';
 * }
 *
 * const error = new LedgerAlreadyExistsError('ledger 42 already exists');
 * error.name; // 'LedgerAlreadyExistsError'
 * error.code; // 'LEDGER_ALREADY_EXISTS'
 * ```
 */
export abstract class DomainError extends Error {
  /** Stable, machine-readable name of this error, in `UPPER_SNAKE_CASE`. */
  abstract readonly code: string;

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
