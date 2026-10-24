/**
 * Accès DynamoDB. Un seul DocumentClient (réutilisé entre invocations froides
 * pour éviter d'ouvrir de nouvelles connexions à chaque appel).
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
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { config } from './config';

let client: DynamoDBDocumentClient | null = null;

export function ddb(): DynamoDBDocumentClient {
  if (!client) {
    const base = new DynamoDBClient({
      region: config().region,
      maxAttempts: 3,
    });
    client = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
  }
  return client;
}

/** Réservé aux tests : injecte un client (DynamoDB Local). */
export function setDdbClient(next: DynamoDBDocumentClient | null): void {
  client = next;
}

export async function getItem<T>(table: string, key: Record<string, unknown>): Promise<T | undefined> {
  const out: GetCommandOutput = await ddb().send(
    new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
  );
  return out.Item as T | undefined;
}

export async function putItem(
  table: string,
  item: Record<string, unknown>,
  options: { condition?: string; names?: Record<string, string>; values?: Record<string, unknown> } = {},
): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: table,
      Item: item,
      ConditionExpression: options.condition,
      ExpressionAttributeNames: options.names,
      ExpressionAttributeValues: options.values,
    }),
  );
}

export async function deleteItem(table: string, key: Record<string, unknown>): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: table, Key: key }));
}

export async function updateItem(
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
  const out = await ddb().send(
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

export async function query<T>(params: {
  table: string;
  index?: string;
  keyCondition: string;
  names?: Record<string, string>;
  values: Record<string, unknown>;
  limit?: number;
  scanForward?: boolean;
  exclusiveStartKey?: Record<string, unknown>;
}): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> {
  const out: QueryCommandOutput = await ddb().send(
    new QueryCommand({
      TableName: params.table,
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

export async function scan<T>(params: {
  table: string;
  filter?: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> {
  const out = await ddb().send(
    new ScanCommand({
      TableName: params.table,
      FilterExpression: params.filter,
      ExpressionAttributeNames: params.names,
      ExpressionAttributeValues: params.values,
      Limit: params.limit,
      ExclusiveStartKey: params.exclusiveStartKey,
    }),
  );
  return { items: (out.Items ?? []) as T[], lastKey: out.LastEvaluatedKey };
}

export interface TransactItem {
  put?: { table: string; item: Record<string, unknown>; condition?: string; names?: Record<string, string>; values?: Record<string, unknown> };
  update?: {
    table: string;
    key: Record<string, unknown>;
    update: string;
    condition?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  };
  delete?: { table: string; key: Record<string, unknown>; condition?: string };
}

/** Transaction atomique : tout réussit ou rien n'est appliqué (C1, C4). */
export async function transactWrite(items: TransactItem[]): Promise<
  { ok: true } | { ok: false; reasons: Array<{ code?: string; message?: string }> }
> {
  const TransactItems = items.map((entry) => {
    if (entry.put) {
      return {
        Put: {
          TableName: entry.put.table,
          Item: entry.put.item,
          ConditionExpression: entry.put.condition,
          ExpressionAttributeNames: entry.put.names,
          ExpressionAttributeValues: entry.put.values,
        },
      };
    }
    if (entry.update) {
      return {
        Update: {
          TableName: entry.update.table,
          Key: entry.update.key,
          UpdateExpression: entry.update.update,
          ConditionExpression: entry.update.condition,
          ExpressionAttributeNames: entry.update.names,
          ExpressionAttributeValues: entry.update.values,
        },
      };
    }
    return {
      Delete: {
        TableName: entry.delete!.table,
        Key: entry.delete!.key,
        ConditionExpression: entry.delete!.condition,
      },
    };
  });

  try {
    await ddb().send(new TransactWriteCommand({ TransactItems: TransactItems as never }));
    return { ok: true };
  } catch (error) {
    const err = error as {
      name?: string;
      CancellationReasons?: Array<{ Code?: string; Message?: string }>;
    };
    if (err.name === 'TransactionCanceledException') {
      return {
        ok: false,
        reasons: (err.CancellationReasons ?? []).map((reason) => ({
          code: reason.Code,
          message: reason.Message,
        })),
      };
    }
    throw error;
  }
}

export function isConditionalFailure(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'ConditionalCheckFailedException';
}

/** Marshalling utils réexportés pour les rares endroits qui en ont besoin. */
export type { NativeAttributeValue };
