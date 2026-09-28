# Daric Ledger

[![Daric Platform](https://img.shields.io/badge/Daric_Platform-Ledger-black)](https://github.com/DaricLabs)
![TypeScript](https://img.shields.io/badge/TypeScript-v6-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%20v24-339933?logo=nodedotjs&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-v12-E0234E?logo=nestjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

Daric Ledger is an API-first accounting service for recording and tracking the movement of value across ledgers, accounts, and assets.

Transactions are represented as immutable postings between accounts. The ledger maintains current account balances alongside a permanent, append-only transaction history, providing a consistent record for reconciliation, auditing, and verification.

Designed as an independent microservice within the Daric platform, Daric Ledger provides a source of truth for financial state while remaining domain-neutral. It can support wallets, payment platforms, exchanges, marketplaces, lending systems, and other applications that require deterministic and auditable accounting.

The current implementation uses PostgreSQL as its transactional datastore and focuses on:

* Tenant-scoped data and isolation
* Transactional integrity and consistency
* Immutable, append-only accounting records
* Reliable event publishing through an outbox pattern
* Tamper-evident audit anchoring

Application-specific concepts such as users, wallets, orders, and payments remain within their respective domains and interact with the ledger through well-defined interfaces.

## Acknowledgments

Daric Ledger's domain model and core concepts are inspired by [Formance](https://github.com/formancehq).
