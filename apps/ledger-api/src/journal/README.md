# journal

The write path that every feature changing ledger state shares. It is not a
feature: it has no HTTP routes and no domain rules.

| Port                       | Job                                                   |
| :------------------------- | :---------------------------------------------------- |
| `ITenantTransactionRunner` | Opens one database transaction for one organization   |
| `ILedgerLogWriter`         | Adds an entry to the ledger journal (`ledger_logs`)   |
| `IOutboxWriter`            | Saves an event for later publishing (`outbox_events`) |

## Rules

1. **Features import `JournalModule`** and inject the ports by their tokens.
   They never import the adapters.
2. **Journal never imports a feature.** It does not know what a ledger entry or
   an event means. `type`, `eventType` and the payloads are plain data that the
   feature owns. Each feature keeps its own list of log types.
3. **Same layers as a feature:** ports in `application/ports/`, Kysely adapters
   in `infrastructure/`. The application layer does not import `core/`.
4. **Only write-path code goes here.** A reader that lists logs or events, or a
   worker that publishes them, is a feature or another app.
