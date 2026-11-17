# idempotency

Lets an operation run only once for one `Idempotency-Key`. It is not a feature:
it has no HTTP routes of its own and no business rules.

A client that does not know if its request worked (a timeout, a lost
connection) sends the same request again with the same key. The first call
does the work. Every later call with the same key gets the first result and
does nothing.

| Piece                        | Job                                                     |
| :--------------------------- | :------------------------------------------------------ |
| `IIdempotencyKeyRepository`  | `claim`: takes a key for a request, or says it was done |
| `IdempotencyKey()`           | Reads and checks the `Idempotency-Key` header           |
| `IdempotencyExceptionFilter` | Turns `IDEMPOTENCY_KEY_REUSED` into a `422`             |
| `IDEMPOTENT_REPLAYED_HEADER` | Name of the response header that marks a replay         |

## How it works

The key is claimed, the work is done and the result is saved in **one database
transaction**. So a key exists only if the work was saved.

1. The use case builds the id of the transaction it will create, and claims
   the key with that id and the hash of the request.
2. A new key (or an expired one) is written, and the work goes on.
3. A key that is still alive with the same hash is a **replay**: nothing is
   written, and the use case answers with the transaction the key points to.
4. A key that is still alive with another hash is **reused**:
   `IdempotencyKeyReusedError` (`IDEMPOTENCY_KEY_REUSED`, HTTP `422`).

Two requests with the same key at the same moment cannot both run: the second
one waits on the primary key until the first one ends. If the first commits,
the second is a replay. If it rolls back, the second one runs.

A request that fails (not enough money, a duplicate reference, a crash) rolls
everything back, so its key is free and a retry runs again. Only successful
requests are remembered.

## Rules

1. **Same database transaction.** `claim` takes the `TenantTransaction` of the
   work it protects. Never claim in a transaction of its own: a crash between
   the work and the key would let the retry run the work twice.
2. **Scope.** A key is unique for one organization, one ledger, one operation
   and the key text. The same text in another ledger or operation is another key.
3. **Lifetime.** A key is remembered for 24 hours (`IDEMPOTENCY_KEY_TTL_SECONDS`).
   An expired row is replaced by the next request with the same key. There is
   no cleanup job yet.
4. **The request hash** is made by the feature, not here. It must cover the
   whole request, in a fixed order, so the same request always gives the same
   hash.
5. **Only features that need it use keys.** Today that is create transaction.
   Create ledger is protected by its unique name, and metadata edits are safe to
   repeat.
6. **Idempotency never imports a feature.** It knows an operation by a plain
   string, and a transaction by its id. The feature owns its operation names.
7. **Not for slow outside calls.** If an operation must call a slow outside
   system (a PSP) between the claim and the end, it cannot keep a database
   transaction open. That needs a lease with an "in progress" state, in the
   service that makes those calls, and not in the ledger.
