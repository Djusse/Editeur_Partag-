/**
 * Accès DynamoDB.
 *
 * Un seul `DynamoDBDocumentClient` est réutilisé pour la vie du processus :
 * sur EC2, cela évite de rouvrir des connexions à chaque requête.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config';

export interface TransactEntry {
  Put?: {
    table: string;
    item: Record<string, unknown>;
    condition?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  };
  Update?: {
    table: string;
    key: Record<string, unknown>;
    update: string;
    condition?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  };
  Delete?: { table: string; key: Record<string, unknown>; condition?: string };
}

/** Interface minimale : permet d'injecter un double en mémoire (tests, local). */
export interface Database {
  get<T>(table: string, key: Record<string, unknown>): Promise<T | undefined>;
  put(
    table: string,
    item: Record<string, unknown>,
    options?: { condition?: string; names?: Record<string, string>; values?: Record<string, unknown> },
  ): Promise<void>;
  update(
    table: string,
    key: Record<string, unknown>,
    params: {
      update: string;
      condition?: string;
      names?: Record<string, string>;
      values?: Record<string, unknown>;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'NONE';
    },
  ): Promise<Record<string, unknown> | undefined>;
  delete(table: string, key: Record<string, unknown>): Promise<void>;
  query<T>(
    table: string,
    params: {
      index?: string;
      keyCondition: string;
      names?: Record<string, string>;
      values: Record<string, unknown>;
      limit?: number;
      scanForward?: boolean;
      exclusiveStartKey?: Record<string, unknown>;
    },
  ): Promise<{ items: T[]; lastKey?: Record<string, unknown> }>;
  scan<T>(
    table: string,
    params?: {
      filter?: string;
      names?: Record<string, string>;
      values?: Record<string, unknown>;
      limit?: number;
    },
  ): Promise<T[]>;
  transact(entries: TransactEntry[]): Promise<{ ok: true } | { ok: false; reasons: Array<{ code?: string }> }>;
}

class DynamoDatabase implements Database {
  private client: DynamoDBDocumentClient | null = null;
  private readonly region: string;

  constructor(region: string) {
    this.region = region;
  }

  private doc(): DynamoDBDocumentClient {
    if (!this.client) {
      const base = new DynamoDBClient({ region: this.region, maxAttempts: 3 });
      this.client = DynamoDBDocumentClient.from(base, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    return this.client;
  }

  async get<T>(table: string, key: Record<string, unknown>): Promise<T | undefined> {
    const out = await this.doc().send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return out.Item as T | undefined;
  }

  async put(
    table: string,
    item: Record<string, unknown>,
    options: { condition?: string; names?: Record<string, string>; values?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.doc().send(
      new PutCommand({
        TableName: table,
        Item: item,
        ConditionExpression: options.condition,
        ExpressionAttributeNames: options.names,
        ExpressionAttributeValues: options.values,
      }),
    );
  }

  async update(
    table: string,
    key: Record<string, unknown>,
    params: {
      update: string;
      condition?: string;
      names?: Record<string, string>;
      values?: Record<string, unknown>;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'NONE';
    },
  ): Promise<Record<string, unknown> | undefined> {
    const out = await this.doc().send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: params.update,
        ConditionExpression: params.condition,
        ExpressionAttributeNames: params.names,
        ExpressionAttributeValues: params.values,
        ReturnValues: params.returnValues ?? 'ALL_NEW',
      }),
    );
    return out.Attributes;
  }

  async delete(table: string, key: Record<string, unknown>): Promise<void> {
    await this.doc().send(new DeleteCommand({ TableName: table, Key: key }));
  }

  async query<T>(
    table: string,
    params: {
      index?: string;
      keyCondition: string;
      names?: Record<string, string>;
      values: Record<string, unknown>;
      limit?: number;
      scanForward?: boolean;
      exclusiveStartKey?: Record<string, unknown>;
    },
  ): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> {
    const out = await this.doc().send(
      new QueryCommand({
        TableName: table,
        IndexName: params.index,
        KeyConditionExpression: params.keyCondition,
        ExpressionAttributeNames: params.names,
        ExpressionAttributeValues: params.values,
        Limit: params.limit,
        ScanIndexForward: params.scanForward ?? true,
        ExclusiveStartKey: params.exclusiveStartKey,
      }),
    );
    return { items: (out.Items ?? []) as T[], lastKey: out.LastEvaluatedKey };
  }

  async scan<T>(
    table: string,
    params: {
      filter?: string;
      names?: Record<string, string>;
      values?: Record<string, unknown>;
      limit?: number;
    } = {},
  ): Promise<T[]> {
    const out = await this.doc().send(
      new ScanCommand({
        TableName: table,
        FilterExpression: params.filter,
        ExpressionAttributeNames: params.names,
        ExpressionAttributeValues: params.values,
        Limit: params.limit,
      }),
    );
    return (out.Items ?? []) as T[];
  }

  async transact(entries: TransactEntry[]): Promise<{ ok: true } | { ok: false; reasons: Array<{ code?: string }> }> {
    const TransactItems = entries.map((entry) => {
      if (entry.Put) {
        return {
          Put: {
            TableName: entry.Put.table,
            Item: entry.Put.item,
            ConditionExpression: entry.Put.condition,
            ExpressionAttributeNames: entry.Put.names,
            ExpressionAttributeValues: entry.Put.values,
          },
        };
      }
      if (entry.Update) {
        return {
          Update: {
            TableName: entry.Update.table,
            Key: entry.Update.key,
            UpdateExpression: entry.Update.update,
            ConditionExpression: entry.Update.condition,
            ExpressionAttributeNames: entry.Update.names,
            ExpressionAttributeValues: entry.Update.values,
          },
        };
      }
      return {
        Delete: {
          TableName: entry.Delete!.table,
          Key: entry.Delete!.key,
          ConditionExpression: entry.Delete!.condition,
        },
      };
    });

    try {
      await this.doc().send(new TransactWriteCommand({ TransactItems: TransactItems as never }));
      return { ok: true };
    } catch (error) {
      const err = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (err.name === 'TransactionCanceledException') {
        return {
          ok: false,
          reasons: (err.CancellationReasons ?? []).map((reason) => ({ code: reason.Code })),
        };
      }
      throw error;
    }
  }
}

let instance: Database | null = null;

export function db(): Database {
  if (!instance) instance = new DynamoDatabase(config().region);
  return instance;
}

/** Réservé aux tests et au mode local : injecte une autre implémentation. */
export function setDatabase(next: Database | null): void {
  instance = next;
}

export function isConditionalFailure(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ConditionalCheckFailedException';
}
