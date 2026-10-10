import type { ColumnType } from 'kysely';

export type MoneyColumn = ColumnType<string, string | bigint, string | bigint>;
