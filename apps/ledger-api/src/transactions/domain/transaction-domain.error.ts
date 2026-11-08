import { DomainError } from '@ledger/domain';

/**
 * Base class of every error of the transactions feature.
 *
 * It adds nothing on its own. It exists so the HTTP layer of this feature can
 * handle transaction errors only (`@Catch(TransactionDomainError)`). Other
 * features extend `DomainError` with their own base class, so one feature
 * never catches the errors of another.
 *
 * Every transaction error must define a `code` (see `DomainError`).
 */
export abstract class TransactionDomainError extends DomainError {}
