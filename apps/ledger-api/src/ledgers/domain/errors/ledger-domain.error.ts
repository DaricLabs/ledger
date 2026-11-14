import { DomainError } from '@ledger/domain';

/**
 * Base class of every error of the ledgers feature.
 *
 * It adds nothing on its own. It exists so the HTTP layer of this feature can
 * handle ledger errors only (`@Catch(LedgerDomainError)`). Other features
 * extend `DomainError` with their own base class, so one feature never
 * catches the errors of another.
 *
 * Every ledger error must define a `code` (see `DomainError`).
 */
export abstract class LedgerDomainError extends DomainError {}
