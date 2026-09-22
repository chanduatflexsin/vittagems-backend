# VittaGems Settlement — ER Diagram

Standalone entity–relationship diagram for the PostgreSQL schema
([`prisma/schema.prisma`](../prisma/schema.prisma)).
Full column/constraint reference: [`DATA_MODEL.md`](./DATA_MODEL.md).
Raw Mermaid source: [`er-diagram.mmd`](./er-diagram.mmd).

```mermaid
erDiagram
    Client ||--o{ ApiKey : "has"
    Client ||--o{ BlockchainAccount : "owns"
    Client ||--o{ Deposit : "makes"
    Client ||--o{ Withdrawal : "requests"
    Client ||--o{ Transaction : "initiates"
    Client ||--o{ WebhookDelivery : "receives"
    Client ||--o{ AuditLog : "generates"

    ApiKey  ||--o{ Permission : "grants"

    Deposit    ||--o{ Transaction : "funds"
    Withdrawal ||--o{ Transaction : "settles"

    Client {
        string   id PK
        string   name
        boolean  isActive
        datetime createdAt
        datetime updatedAt
    }

    ApiKey {
        string   id PK
        string   clientId FK
        string   keyHash UK
        string   name
        boolean  isActive
        datetime expiresAt "nullable"
        datetime lastUsedAt "nullable"
        datetime createdAt
        datetime updatedAt
    }

    Permission {
        string   id PK
        string   apiKeyId FK
        string   scope "MINT | TRANSFER | WITHDRAW"
        datetime createdAt
    }

    BlockchainAccount {
        string   id PK
        string   clientId FK
        string   address UK
        boolean  isActive
        datetime createdAt
        datetime updatedAt
    }

    Deposit {
        string   id PK
        string   clientId FK
        string   referenceId UK
        decimal  amount "Decimal(20,8)"
        string   currency "default USD"
        string   status "PENDING | VERIFIED | REJECTED"
        datetime createdAt
        datetime updatedAt
    }

    Withdrawal {
        string   id PK
        string   clientId FK
        string   idempotencyKey UK
        decimal  amount "Decimal(20,8)"
        json     bankDetails
        string   status "REQUESTED | APPROVED | REJECTED | BURN_PENDING | SETTLED"
        datetime createdAt
        datetime updatedAt
    }

    Transaction {
        string   id PK
        string   clientId FK
        string   type "MINT | TRANSFER | BURN"
        string   referenceId "nullable, on-chain settlement key"
        string   idempotencyKey UK "nullable"
        string   depositId FK "nullable"
        string   withdrawalId FK "nullable"
        decimal  amount "Decimal(20,8)"
        string   fromAddress "nullable"
        string   toAddress "nullable"
        string   status "PENDING | SUBMITTED | CONFIRMED | FAILED"
        string   blockchainTxHash UK "nullable"
        string   failureReason "nullable"
        datetime createdAt
        datetime updatedAt
    }

    WebhookDelivery {
        string   id PK
        string   clientId FK
        string   event
        json     payload
        string   status "PENDING | DELIVERED | FAILED"
        int      attempts "default 0"
        datetime createdAt
        datetime updatedAt
    }

    AuditLog {
        string   id PK
        string   clientId FK "nullable"
        string   action
        json     details
        datetime createdAt
    }
```

## Relationships at a glance

| From | To | Cardinality | Via |
|------|----|-------------|-----|
| Client | ApiKey | 1 → N | `ApiKey.clientId` |
| Client | BlockchainAccount | 1 → N | `BlockchainAccount.clientId` |
| Client | Deposit | 1 → N | `Deposit.clientId` |
| Client | Withdrawal | 1 → N | `Withdrawal.clientId` |
| Client | Transaction | 1 → N | `Transaction.clientId` |
| Client | WebhookDelivery | 1 → N | `WebhookDelivery.clientId` |
| Client | AuditLog | 1 → N (nullable) | `AuditLog.clientId` |
| ApiKey | Permission | 1 → N | `Permission.apiKeyId` |
| Deposit | Transaction | 1 → N (nullable) | `Transaction.depositId` |
| Withdrawal | Transaction | 1 → N (nullable) | `Transaction.withdrawalId` |
