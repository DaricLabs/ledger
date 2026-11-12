# @ledger/domain

Domain code that more than one app or feature can share. It is pure
TypeScript: no framework, no database, no HTTP.

## What is inside

| Folder          | Files end with | What is inside                                                    |
| :-------------- | :------------- | :---------------------------------------------------------------- |
| `value-objects` | `.vo.ts`       | `AssetCode`, `AccountAddress` (with the `world` address), `Money` |
| `errors`        | `.error.ts`    | `DomainError`, `ValueObjectError`, and the errors of the above    |

- `DomainError` is the base class of every business error. It needs a `code`.
- `ValueObjectError` is the base class of the errors of the value objects, so
  one place can handle all of them.
- `Money` is an exact amount (`bigint`) of one asset, within the range of the
  database columns.
- `index.ts` is the only public entry. Apps import from `@ledger/domain`, never
  from a file inside it.

## Rules

1. **Nothing here may import a framework** (NestJS, Express, Kysely, `pg`).
   If it needs one, it is not domain code.
2. **Only shared code lives here.** If just one feature uses it, keep it in
   that feature's `domain/` folder and move it here when a second user shows up.
3. **Patterns must match the database.** `ASSET_CODE_PATTERN` and
   `ACCOUNT_ADDRESS_PATTERN`, and the money range, are written again in
   `0001_init.sql`. If you change one side, change the other.
4. **Tests live next to the file they test**, as `<name>.spec.ts`. Everything
   here is a unit test: no database, no network.
