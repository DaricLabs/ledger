# core

App-wide technical parts of `ledger-api`. Nothing here knows about ledgers,
accounts or transactions. Business features live next to this folder in `src/`.

## What is inside

| Folder        | Job                                                        |
| :------------ | :--------------------------------------------------------- |
| `config/`     | Reads and checks environment variables at startup          |
| `database/`   | Creates the database pool and checks the runtime role      |
| `errors/`     | The one error body, the global error filter, error logging |
| `health/`     | Liveness endpoint                                          |
| `logging/`    | Pino setup, request ids, log levels                        |
| `tenant/`     | `TenantGuard` and `@OrganizationId()`                      |
| `validation/` | Global schema pipe, so `@Body({ schema })` works           |

## Rules

1. **No `CoreModule`.** Each folder keeps its own small module, or has none
   (`tenant/` needs none). A module that provides everything becomes a god
   module, so we never make one.
2. **Name the folder for the concern** (`tenant`, `errors`), never `common`,
   `shared` or `utils`.
3. **No business words.** If code uses ledger tables or domain terms, it
   belongs in a feature, not here.
4. **Imports go one way.** Features may import from `core/`. `core/` must
   never import from a feature.
5. **Domain and application layers never import from `core/`.** It is the
   framework side. Use cases get plain values, like `organizationId`, as
   arguments.
6. **Feature errors stay in the feature.** The global error filter only knows
   `HttpException` and unknown errors. Mapping a domain error to HTTP happens
   in the feature's `presentation/` folder.
7. **Add a `*.module.ts` only when DI needs it.**

## Where does new code go?

- Would another service use it without any change? Put it in `core/`.
- Does it mention ledgers, accounts, transactions or other domain words?
  Put it in a feature.
- Not sure? Start in the feature. Moving it to `core/` later is easy.
  Moving it back out is harder.
