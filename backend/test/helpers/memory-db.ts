/**
 * Double en mémoire de DynamoDB, utilisé par les tests **et** par le mode local.
 *
 * Ce n'est pas un émulateur : il n'implémente que les expressions réellement
 * employées par l'application (conditions, transactions, compteurs). C'est
 * suffisant pour prouver les propriétés qui comptent : « jamais N+1 » (C1) et
 * « jamais plus que le crédit » (C4).
 */
import type { Database, TransactEntry } from '../../src/lib/db';

type Item = Record<string, unknown>;

interface Table {
  key: string[];
  rows: Map<string, Item>;
}

function compositeKey(item: Item, keys: string[]): string {
  return keys.map((key) => String(item[key])).join('\u0000');
}

export class MemoryDatabase implements Database {
  readonly tables = new Map<string, Table>();

  constructor(definitions: Array<[string, string[]]>) {
    for (const [name, key] of definitions) this.tables.set(name, { key, rows: new Map() });
  }

  private table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new Error(`Table inconnue : ${name}`);
    return table;
  }

  /** Lecture directe (tests) : contourne l'API publique. */
  peek<T>(name: string, key: Item): T | undefined {
    const table = this.table(name);
    const row = table.rows.get(compositeKey(key, table.key));
    return row ? (structuredClone(row) as T) : undefined;
  }

  rows<T>(name: string): T[] {
    return [...this.table(name).rows.values()].map((row) => structuredClone(row) as T);
  }

  count(name: string): number {
    return this.table(name).rows.size;
  }

  reset(): void {
    for (const table of this.tables.values()) table.rows.clear();
  }

  // --- Database ------------------------------------------------------------
  async get<T>(table: string, key: Item): Promise<T | undefined> {
    return this.peek<T>(table, key);
  }

  async put(
    table: string,
    item: Item,
    options: { condition?: string; names?: Record<string, string>; values?: Record<string, unknown> } = {},
  ): Promise<void> {
    const definition = this.table(table);
    const key = compositeKey(item, definition.key);
    if (options.condition?.includes('attribute_not_exists') && definition.rows.has(key)) {
      throw conditionalFailure();
    }
    definition.rows.set(key, structuredClone(item));
  }

  async update(
    table: string,
    key: Item,
    params: {
      update: string;
      condition?: string;
      names?: Record<string, string>;
      values?: Record<string, unknown>;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'NONE';
    },
  ): Promise<Item | undefined> {
    const definition = this.table(table);
    const composite = compositeKey(key, definition.key);
    const current = definition.rows.get(composite);

    if (params.condition && !evaluate(params.condition, current, params.values ?? {}, params.names ?? {})) {
      throw conditionalFailure();
    }

    const fields = parseUpdate(params.update, params.values ?? {}, params.names ?? {}, current);
    const base = current ? structuredClone(current) : { ...key };
    for (const [field, value] of Object.entries(fields)) base[field] = value;
    definition.rows.set(composite, base);
    return structuredClone(base);
  }

  async delete(table: string, key: Item): Promise<void> {
    const definition = this.table(table);
    definition.rows.delete(compositeKey(key, definition.key));
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
      exclusiveStartKey?: Item;
    },
  ): Promise<{ items: T[]; lastKey?: Item }> {
    const definition = this.table(table);
    let items = [...definition.rows.values()].map((row) => structuredClone(row));

    // Conditions supportées : `docId = :docId` (+ éventuellement `seq > :since`).
    const hashMatch = params.keyCondition.match(/^(\w+) = :(\w+)/);
    if (hashMatch) {
      const field = params.names?.[hashMatch[1]] ?? hashMatch[1];
      const expected = params.values[`:${hashMatch[2]}`];
      items = items.filter((row) => row[field] === expected);
    }

    const rangeMatch = params.keyCondition.match(/(\w+)\s*>\s*:(\w+)/);
    if (rangeMatch) {
      const field = rangeMatch[1];
      const threshold = Number(params.values[`:${rangeMatch[2]}`] ?? 0);
      items = items.filter((row) => Number(row[field] ?? 0) > threshold);
      items.sort((a, b) => Number(a[field] ?? 0) - Number(b[field] ?? 0));
    }

    if (params.index === 'email-index') {
      // La table `Members` est indexée par e-mail : le tri n'a pas d'importance.
      items.sort((a, b) => String(a.email).localeCompare(String(b.email)));
    }

    if (params.scanForward === false) {
      items.reverse();
    } else if (!rangeMatch) {
      items.sort((a, b) => String(b.addedAt ?? b.createdAt ?? '').localeCompare(String(a.addedAt ?? a.createdAt ?? '')));
    }

    const limited = params.limit ? items.slice(0, params.limit) : items;
    return { items: limited as T[] };
  }

  async scan<T>(table: string, params: { limit?: number } = {}): Promise<T[]> {
    const items = this.rows<T>(table);
    return params.limit ? items.slice(0, params.limit) : items;
  }

  /**
   * Transaction : **toutes** les conditions sont évaluées avant toute écriture.
   * C'est exactement la garantie dont dépendent C1 et C4.
   */
  async transact(entries: TransactEntry[]): Promise<{ ok: true } | { ok: false; reasons: Array<{ code?: string }> }> {
    const reasons: Array<{ code?: string }> = [];

    for (const entry of entries) {
      if (entry.Put) {
        const definition = this.table(entry.Put.table);
        const exists = definition.rows.has(compositeKey(entry.Put.item, definition.key));
        const failed = Boolean(entry.Put.condition?.includes('attribute_not_exists')) && exists;
        reasons.push({ code: failed ? 'ConditionalCheckFailed' : 'None' });
        continue;
      }
      if (entry.Update) {
        const current = this.peek<Item>(entry.Update.table, entry.Update.key);
        const ok = entry.Update.condition
          ? evaluate(
              entry.Update.condition,
              current,
              entry.Update.values ?? {},
              entry.Update.names ?? {},
            )
          : true;
        reasons.push({ code: ok ? 'None' : 'ConditionalCheckFailed' });
        continue;
      }
      reasons.push({ code: 'None' });
    }

    if (reasons.some((reason) => reason.code !== 'None')) {
      return { ok: false, reasons };
    }

    for (const entry of entries) {
      if (entry.Put) {
        const definition = this.table(entry.Put.table);
        definition.rows.set(compositeKey(entry.Put.item, definition.key), structuredClone(entry.Put.item));
        continue;
      }
      if (entry.Update) {
        const definition = this.table(entry.Update.table);
        const composite = compositeKey(entry.Update.key, definition.key);
        const current = definition.rows.get(composite);
        const fields = parseUpdate(
          entry.Update.update,
          entry.Update.values ?? {},
          entry.Update.names ?? {},
          current,
        );
        const base = current ? structuredClone(current) : { ...entry.Update.key };
        for (const [field, value] of Object.entries(fields)) base[field] = value;
        definition.rows.set(composite, base);
        continue;
      }
      if (entry.Delete) {
        const definition = this.table(entry.Delete.table);
        definition.rows.delete(compositeKey(entry.Delete.key, definition.key));
      }
    }

    return { ok: true };
  }
}

function conditionalFailure(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/** Interprète une expression `SET …` / `ADD …` (sous-ensemble suffisant). */
function parseUpdate(
  expression: string,
  values: Record<string, unknown>,
  names: Record<string, string>,
  current: Item | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Attention : `[^S]` combiné à l'option `/i` exclurait aussi la lettre « s »,
  // ce qui tronquerait des noms comme `:minusOne`. On découpe explicitement.
  const addMatch = expression.match(/\bADD\b([\s\S]*?)(?=\bSET\b|$)/i);
  if (addMatch) {
    for (const clause of addMatch[1].split(',')) {
      const match = clause.trim().match(/^([#\w]+)\s+:(\w+)$/);
      if (!match) continue;
      const field = names[match[1]] ?? match[1];
      const delta = values[`:${match[2]}`];
      out[field] = Number(current?.[field] ?? 0) + Number(delta ?? 0);
    }
  }

  const setPart = expression.match(/SET\s+(.+)$/i);
  if (setPart) {
    for (const clause of splitTopLevel(setPart[1])) {
      const match = clause.trim().match(/^([#\w]+)\s*=\s*(.+)$/);
      if (!match) continue;
      const field = names[match[1]] ?? match[1];
      const right = match[2].trim();

      const ifNotExists = right.match(/^if_not_exists\(([#\w]+),\s*:(\w+)\)(?:\s*\+\s*:(\w+))?$/);
      if (ifNotExists) {
        const base = current?.[field] ?? values[`:${ifNotExists[2]}`];
        const delta = ifNotExists[3] ? Number(values[`:${ifNotExists[3]}`] ?? 0) : 0;
        out[field] = Number(base ?? 0) + delta;
        continue;
      }

      const valueRef = right.match(/^:(\w+)$/);
      if (valueRef) {
        out[field] = values[`:${valueRef[1]}`];
      }
    }
  }

  return out;
}

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

/** Évalue une condition DynamoDB (sous-ensemble réellement utilisé). */
function evaluate(
  expression: string,
  current: Item | undefined,
  values: Record<string, unknown>,
  names: Record<string, string>,
): boolean {
  const trimmed = stripOuterParens(expression.trim());

  if (splitTopLevelOperator(trimmed, ' AND ').length > 1) {
    return splitTopLevelOperator(trimmed, ' AND ').every((part) => evaluate(part.trim(), current, values, names));
  }
  if (splitTopLevelOperator(trimmed, ' OR ').length > 1) {
    return splitTopLevelOperator(trimmed, ' OR ').some((part) => evaluate(part.trim(), current, values, names));
  }
  if (trimmed !== expression.trim()) {
    return evaluate(trimmed, current, values, names);
  }

  // `:delta <= :limit` (comparaison de deux valeurs)
  const twoValues = expression.match(/^:(\w+)\s*<=\s*:(\w+)$/);
  if (twoValues) {
    return Number(values[`:${twoValues[1]}`] ?? 0) <= Number(values[`:${twoValues[2]}`] ?? 0);
  }

  if (expression.includes('attribute_not_exists')) {
    const field = expression.match(/attribute_not_exists\(([#\w]+)\)/)?.[1];
    if (!field) return current === undefined;
    const real = names[field] ?? field;
    return current === undefined || current[real] === undefined;
  }
  if (expression.includes('attribute_exists')) return current !== undefined;

  // `used + :chars <= :limit`
  const addCompare = expression.match(/([#\w]+)\s*\+\s*:(\w+)\s*<=\s*:(\w+)/);
  if (addCompare) {
    const field = names[addCompare[1]] ?? addCompare[1];
    const delta = Number(values[`:${addCompare[2]}`] ?? 0);
    const limit = Number(values[`:${addCompare[3]}`] ?? 0);
    return Number(current?.[field] ?? 0) + delta <= limit;
  }

  // `remaining > :zero`
  const greater = expression.match(/([#\w]+)\s*>\s*:(\w+)/);
  if (greater) {
    const field = names[greater[1]] ?? greater[1];
    return Number(current?.[field] ?? 0) > Number(values[`:${greater[2]}`] ?? 0);
  }

  // `seq = :current`, `#status = :active`, `leaseUntil < :now`
  const equal = expression.match(/([#\w]+)\s*=\s*:(\w+)/);
  if (equal) {
    const field = names[equal[1]] ?? equal[1];
    return current?.[field] === values[`:${equal[2]}`];
  }
  const lower = expression.match(/([#\w]+)\s*<\s*:(\w+)/);
  if (lower) {
    const field = names[lower[1]] ?? lower[1];
    return Number(current?.[field] ?? 0) < Number(values[`:${lower[2]}`] ?? 0);
  }

  return true;
}
