# @ledger/domain

Domain code that more than one app or feature can share. It is pure
TypeScript: no framework, no database, no HTTP.

## What is inside

| File              | Job                                                                       |
| :---------------- | :------------------------------------------------------------------------ |
| `domain-error.ts` | `DomainError`: base class of every business error, with a required `code` |

## Rules

1. **Nothing here may import a framework** (NestJS, Express, Kysely, `pg`).
   If it needs one, it is not domain code.
2. **Only shared code lives here.** If just one feature uses it, keep it in
   that feature's `domain/` folder and move it here when a second user shows up.
