/**
 * Double en mémoire de DynamoDB, suffisant pour tester la logique critique
 * (transaction atomique, conditions, compteurs) sans Docker.
 *
 * Ce n'est pas un émulateur complet : il n'implémente que les expressions
 * utilisées par l'application, ce qui suffit à prouver les propriétés visées
 * (C1 : jamais N+1 ; C4 : jamais plus que le crédit).
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export class ConditionalCheckFailed extends Error {
  constructor() {
    super('The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

type Item = Record<string, unknown>;

interface Table {
  key: string[];
  rows: Map<string, Item>;
}

interface TransactionEntry {
  Put?: { TableName: string; Item: Item; ConditionExpression?: string };
  Update?: {
    TableName: string;
    Key: Item;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
  Delete?: { TableName: string; Key: Item; ConditionExpression?: string };
}

function compositeKey(item: Item, keys: string[]): string {
  return keys.map((key) => String(item[key])).join('\u0000');
}

export class MemoryDynamo {
  readonly tables = new Map<string, Table>();

  createTable(name: string, key: string[]): void {
    this.tables.set(name, { key, rows: new Map() });
  }

  private table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new Error(`Table inconnue : ${name}`);
    return table;
  }

  get(table: string, key: Item): Item | undefined {
    const definition = this.table(table);
    const value = definition.rows.get(compositeKey(key, definition.key));
    return value ? structuredClone(value) : undefined;
  }

  put(table: string, item: Item, condition?: 'attribute_not_exists'): void {
    const definition = this.table(table);
    const key = compositeKey(item, definition.key);
    if (condition === 'attribute_not_exists' && definition.rows.has(key)) {
      throw new ConditionalCheckFailed();
    }
    definition.rows.set(key, structuredClone(item));
  }

  update(
    table: string,
    key: Item,
    changes: Record<string, number | string | boolean>,
    mode: 'ADD' | 'SET' = 'SET',
    condition?: (current: Item | undefined) => boolean,
  ): Item {
    const definition = this.table(table);
    const composite = compositeKey(key, definition.key);
    const current = definition.rows.get(composite);
    if (condition && !condition(current ? structuredClone(current) : undefined)) {
      throw new ConditionalCheckFailed();
    }
    const base = current ? structuredClone(current) : { ...key };
    for (const [field, value] of Object.entries(changes)) {
      if (mode === 'ADD' && typeof value === 'number') {
        base[field] = Number(base[field] ?? 0) + value;
      } else {
        base[field] = value;
      }
    }
    definition.rows.set(composite, base);
    return structuredClone(base);
  }

  all(table: string): Item[] {
    return [...this.table(table).rows.values()].map((row) => structuredClone(row));
  }

  count(table: string): number {
    return this.table(table).rows.size;
  }

  /**
   * Transaction : toutes les conditions sont évaluées **avant** toute écriture.
   * C'est exactement la garantie dont dépendent C1 et C4.
   */
  transact(entries: TransactionEntry[]): unknown {
    const reasons: Array<{ Code: string }> = [];

    for (const entry of entries) {
      const tableName = entry.Put?.TableName ?? entry.Update?.TableName ?? entry.Delete?.TableName ?? '';
      const condition = entry.Put?.ConditionExpression ?? entry.Update?.ConditionExpression ?? entry.Delete?.ConditionExpression;
      let failed = false;

      if (condition) {
        if (entry.Put) {
          const definition = this.table(tableName);
          failed = definition.rows.has(compositeKey(entry.Put.Item, definition.key));
        } else if (entry.Update) {
          const current = this.get(tableName, entry.Update.Key);
          failed = !evaluateCondition(
            condition,
            current,
            entry.Update.ExpressionAttributeValues ?? {},
            entry.Update.ExpressionAttributeNames ?? {},
          );
        }
      }
      reasons.push({ Code: failed ? 'ConditionalCheckFailed' : 'None' });
    }

    if (reasons.some((reason) => reason.Code !== 'None')) {
      const error = new Error('Transaction cancelled');
      error.name = 'TransactionCanceledException';
      (error as unknown as { CancellationReasons: Array<{ Code: string }> }).CancellationReasons = reasons;
      throw error;
    }

    for (const entry of entries) {
      if (entry.Put) {
        const definition = this.table(entry.Put.TableName);
        definition.rows.set(compositeKey(entry.Put.Item, definition.key), structuredClone(entry.Put.Item));
        continue;
      }
      if (entry.Delete) {
        const definition = this.table(entry.Delete.TableName);
        definition.rows.delete(compositeKey(entry.Delete.Key, definition.key));
        continue;
      }
      if (entry.Update) {
        const values = entry.Update.ExpressionAttributeValues ?? {};
        const names = entry.Update.ExpressionAttributeNames ?? {};
        const expression = entry.Update.UpdateExpression;
        const fields: Record<string, number | string | boolean> = {};
        let mode: 'ADD' | 'SET' = 'SET';

        if (/^\s*ADD /i.test(expression)) {
          mode = 'ADD';
          for (const [, field, valueKey] of expression.matchAll(/ADD (\w+) :(\w+)/gi)) {
            fields[names[field] ?? field] = values[`:${valueKey}`] as number;
          }
        } else {
          const setPart = expression.replace(/^\s*SET /i, '');
          const current = this.get(entry.Update.TableName, entry.Update.Key);
          for (const clause of splitTopLevel(setPart)) {
            const match = clause.trim().match(/^([#\w]+)\s*=\s*(.+)$/);
            if (!match) continue;
            const field = names[match[1]] ?? match[1];
            const right = match[2].trim();
            const ifNotExists = right.match(/if_not_exists\((\w+),\s*:(\w+)\)\s*(?:\+\s*:(\w+))?/);
            if (ifNotExists) {
              const base = (current?.[field] as number) ?? (values[`:${ifNotExists[2]}`] as number) ?? 0;
              const delta = ifNotExists[3] ? (values[`:${ifNotExists[3]}`] as number) : 0;
              fields[field] = base + delta;
            } else if (right.startsWith(':')) {
              fields[field] = values[right] as string | number;
            } else {
              fields[field] = (current?.[field] as number) ?? 0;
            }
          }
        }
        this.update(entry.Update.TableName, entry.Update.Key, fields, mode);
      }
    }

    return {};
  }

  /** Client compatible `DynamoDBDocumentClient.send`. */
  client(): DynamoDBDocumentClient {
    const self = this;
    return {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        const input = command.input;
        const tableName = String(input.TableName);

        if (name === 'GetCommand') {
          return { Item: self.get(tableName, input.Key as Item) };
        }

        if (name === 'PutCommand') {
          const condition = String(input.ConditionExpression ?? '');
          self.put(tableName, input.Item as Item, condition.includes('attribute_not_exists') ? 'attribute_not_exists' : undefined);
          return {};
        }

        if (name === 'UpdateCommand') {
          const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
          const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
          const expression = String(input.UpdateExpression ?? '');
          const condition = String(input.ConditionExpression ?? '');

          const fields: Record<string, number | string | boolean> = {};
          let mode: 'ADD' | 'SET' = 'SET';
          const addMatch = expression.match(/^ADD (\w+) :(\w+)/i);
          if (addMatch) {
            mode = 'ADD';
            fields[addMatch[1]] = values[`:${addMatch[2]}`] as number;
          } else {
            for (const match of expression.matchAll(/([#\w]+)\s*=\s*:(\w+)/g)) {
              fields[names[match[1]] ?? match[1]] = values[`:${match[2]}`] as string | number | boolean;
            }
          }

          const evaluator = condition
            ? (current: Item | undefined) => evaluateCondition(condition, current, values, names)
            : undefined;

          return { Attributes: self.update(tableName, input.Key as Item, fields, mode, evaluator) };
        }

        if (name === 'TransactWriteCommand') {
          return self.transact(input.TransactItems as TransactionEntry[]);
        }

        if (name === 'ScanCommand' || name === 'QueryCommand') {
          return { Items: self.all(tableName) };
        }

        if (name === 'DeleteCommand') {
          return {};
        }

        throw new Error(`Commande non simulée : ${name}`);
      },
    } as unknown as DynamoDBDocumentClient;
  }
}

/** Découpe une expression SET sur les virgules de premier niveau. */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of expression) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Retire les parenthèses englobantes d'une expression entière. */
function stripOuterParens(expression: string): string {
  let value = expression.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let index = 0; index < value.length; index++) {
      if (value[index] === '(') depth++;
      if (value[index] === ')') depth--;
      if (depth === 0 && index < value.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function containsTopLevel(expression: string, operator: string): boolean {
  return splitTopLevelOperator(expression, operator).length > 1;
}

/** Découpe sur un opérateur logique de premier niveau (hors parenthèses). */
function splitTopLevelOperator(expression: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(current);
      current = '';
      index += operator.length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Évaluateur minimal des conditions utilisées par le code métier. */
function evaluateCondition(
  expression: string,
  current: Item | undefined,
  values: Record<string, unknown>,
  names: Record<string, string>,
): boolean {
  const trimmedExpression = stripOuterParens(expression.trim());

  // `attribute_not_exists(used) AND :delta <= :limit` en premier (priorité)
  if (containsTopLevel(trimmedExpression, ' AND ')) {
    return splitTopLevelOperator(trimmedExpression, ' AND ').every((part) =>
      evaluateCondition(part.trim(), current, values, names),
    );
  }

  // `... OR ...`
  if (containsTopLevel(trimmedExpression, ' OR ')) {
    return splitTopLevelOperator(trimmedExpression, ' OR ').some((part) =>
      evaluateCondition(part.trim(), current, values, names),
    );
  }
  if (trimmedExpression !== expression.trim()) {
    return evaluateCondition(trimmedExpression, current, values, names);
  }

  // `:delta <= :limit` (valeurs seules, sans attribut)
  const valueCompare = expression.match(/^:(\w+)\s*<=\s*:(\w+)$/);
  if (valueCompare) {
    return Number(values[`:${valueCompare[1]}`] ?? 0) <= Number(values[`:${valueCompare[2]}`] ?? 0);
  }

  if (expression.includes('attribute_not_exists')) {
    const field = expression.match(/attribute_not_exists\((\w+)\)/)?.[1];
    if (!field) return current === undefined;
    return current === undefined || current[field] === undefined;
  }
  if (expression.includes('attribute_exists')) return current !== undefined;

  // `used + :delta <= :limit`
  const addMatch = expression.match(/(\w+)\s*\+\s*:(\w+)\s*<=\s*:(\w+)/);
  if (addMatch) {
    const field = names[addMatch[1]] ?? addMatch[1];
    const delta = Number(values[`:${addMatch[2]}`] ?? 0);
    const limit = Number(values[`:${addMatch[3]}`] ?? 0);
    return Number(current?.[field] ?? 0) + delta <= limit;
  }

  // `remaining > :zero`
  const gtMatch = expression.match(/(\w+)\s*>\s*:(\w+)/);
  if (gtMatch) {
    const field = names[gtMatch[1]] ?? gtMatch[1];
    return Number(current?.[field] ?? 0) > Number(values[`:${gtMatch[2]}`] ?? 0);
  }

  // `seq = :current` / `#status = :active` / `notified = :false`
  const eqMatch = expression.match(/([#\w]+)\s*=\s*:(\w+)/);
  if (eqMatch) {
    const field = names[eqMatch[1]] ?? eqMatch[1];
    return current?.[field] === values[`:${eqMatch[2]}`];
  }

  return true;
}
