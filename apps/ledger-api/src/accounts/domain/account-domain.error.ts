import { DomainError } from '@ledger/domain';

/**
 * Base class of every error of the accounts feature.
 *
 * It adds nothing on its own. It exists so the HTTP layer of this feature can
 * handle account errors only (`@Catch(AccountDomainError)`). Other features
 * extend `DomainError` with their own base class, so one feature never
 * catches the errors of another.
 *
 * Every account error must define a `code` (see `DomainError`).
 */
export abstract class AccountDomainError extends DomainError {}
