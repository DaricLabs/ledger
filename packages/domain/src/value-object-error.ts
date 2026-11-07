import { DomainError } from './domain-error.js';

/**
 * Base class of every error raised by the shared value objects of this
 * package (`AssetCode`, `AccountAddress` and `Money`).
 *
 * It adds nothing on its own. It exists so the outer layer of a feature can
 * handle all of them in one place (`@Catch(ValueObjectError)`) instead of
 * listing each class.
 *
 * Every error must define a `code` (see `DomainError`).
 */
export abstract class ValueObjectError extends DomainError {}
