import type { ParsedStatement } from './parse.js';

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  isGenerated: boolean;
  isPrimaryKey: boolean;
}

interface ExistingIndex {
  name: string;
  tableName: string;
  columns: Array<{
    name: string;
    direction: 'asc' | 'desc';
  }>;
  include?: string[];
  isUnique?: boolean;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  uniqueConstraints: string[][];
  foreignKeys: Array<{
    column: string;
    foreignTable: string;
    foreignColumn: string;
  }>;
  indexes: ExistingIndex[];
}

export interface Catalog {
  tables: Record<string, TableInfo>;
  enumTypes: string[];
}

// Helpers to extract string values and records from AST nodes
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const val = obj[key];
  return isRecord(val) ? val : undefined;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function getStringVal(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const sval = getString(node, 'sval');
  if (sval !== undefined) return sval;
  const stringObj = getRecord(node, 'String');
  if (stringObj) {
    const nested = getString(stringObj, 'sval');
    if (nested !== undefined) return nested;
  }
  return null;
}

function getTypeName(typeNameNode: unknown): string {
  if (!isRecord(typeNameNode)) return 'unknown';
  const names = typeNameNode['names'];
  if (Array.isArray(names) && names.length > 0) {
    // Return the last component of the name (e.g. pg_catalog.varchar -> varchar)
    const last = names[names.length - 1];
    const sval = getStringVal(last);
    if (sval) return sval.toLowerCase();
  }
  return 'unknown';
}

function extractKeyNames(keysNode: unknown): string[] {
  if (!Array.isArray(keysNode)) return [];
  const result: string[] = [];
  for (const k of keysNode) {
    const s = getStringVal(k);
    if (s) result.push(s);
  }
  return result;
}

/**
 * Builds an in-memory database catalog from validated AST statements.
 * Never introspects runtime databases or includes raw user comments/enum labels (I9).
 */
export function buildCatalog(stmts: ParsedStatement[]): Catalog {
  const catalog: Catalog = {
    tables: {},
    enumTypes: [],
  };

  for (const { stmt } of stmts) {
    // 1. CREATE TABLE
    const cstmt = getRecord(stmt, 'CreateStmt');
    if (cstmt) {
      const rel = getRecord(cstmt, 'relation');
      const tableName = rel ? (getString(rel, 'relname') ?? '') : '';
      if (!tableName) continue;

      const table: TableInfo = {
        name: tableName,
        columns: [],
        primaryKey: [],
        uniqueConstraints: [],
        foreignKeys: [],
        indexes: [],
      };

      const tableElts = cstmt['tableElts'];
      if (Array.isArray(tableElts)) {
        for (const elt of tableElts) {
          if (!isRecord(elt)) continue;

          // Column Definition
          const colDef = getRecord(elt, 'ColumnDef');
          if (colDef) {
            const colName = getString(colDef, 'colname') ?? '';
            const typeName = getTypeName(colDef['typeName']);

            let nullable = true;
            let hasDefault = false;
            let isGenerated = false;
            let isPrimaryKey = false;

            const constraints = colDef['constraints'];
            if (Array.isArray(constraints)) {
              for (const c of constraints) {
                if (!isRecord(c)) continue;
                const constraint = getRecord(c, 'Constraint');
                if (!constraint) continue;

                const contype = getString(constraint, 'contype') ?? '';
                if (contype === 'CONSTR_PRIMARY') {
                  isPrimaryKey = true;
                  nullable = false;
                  if (!table.primaryKey.includes(colName)) {
                    table.primaryKey.push(colName);
                  }
                } else if (contype === 'CONSTR_NOTNULL') {
                  nullable = false;
                } else if (contype === 'CONSTR_DEFAULT') {
                  hasDefault = true;
                } else if (contype === 'CONSTR_GENERATED') {
                  isGenerated = true;
                } else if (contype === 'CONSTR_UNIQUE') {
                  table.uniqueConstraints.push([colName]);
                }
              }
            }

            table.columns.push({
              name: colName,
              type: typeName,
              nullable,
              hasDefault,
              isGenerated,
              isPrimaryKey,
            });
          }

          // Table-level Constraint
          const constraint = getRecord(elt, 'Constraint');
          if (constraint) {
            const contype = getString(constraint, 'contype') ?? '';

            if (contype === 'CONSTR_PRIMARY') {
              const keys = extractKeyNames(constraint['keys']);
              table.primaryKey = keys;
              for (const col of table.columns) {
                if (keys.includes(col.name)) {
                  col.isPrimaryKey = true;
                  col.nullable = false;
                }
              }
            } else if (contype === 'CONSTR_UNIQUE') {
              const keys = extractKeyNames(constraint['keys']);
              if (keys.length > 0) table.uniqueConstraints.push(keys);
            } else if (contype === 'CONSTR_FOREIGN') {
              const fkAttrs = extractKeyNames(constraint['fk_attrs']);
              const pkAttrs = extractKeyNames(constraint['pk_attrs']);
              const pktable = getRecord(constraint, 'pktable');
              const foreignTable = pktable ? (getString(pktable, 'relname') ?? '') : '';

              if (fkAttrs.length > 0 && foreignTable) {
                table.foreignKeys.push({
                  column: fkAttrs[0]!,
                  foreignTable,
                  foreignColumn: pkAttrs[0] || 'id',
                });
              }
            }
          }
        }
      }

      catalog.tables[tableName] = table;
    }

    // 2. CREATE TYPE ... AS ENUM
    const enumStmt = getRecord(stmt, 'CreateEnumStmt');
    if (enumStmt) {
      const typeNames = enumStmt['typeName'];
      if (Array.isArray(typeNames) && typeNames.length > 0) {
        const last = typeNames[typeNames.length - 1];
        const sval = getStringVal(last);
        if (sval && !catalog.enumTypes.includes(sval)) {
          catalog.enumTypes.push(sval);
        }
      }
    }

    // 3. CREATE INDEX
    const idxStmt = getRecord(stmt, 'IndexStmt');
    if (idxStmt) {
      const idxName = getString(idxStmt, 'idxname') ?? '';
      const rel = getRecord(idxStmt, 'relation');
      const tableName = rel ? (getString(rel, 'relname') ?? '') : '';

      const indexCols: ExistingIndex['columns'] = [];
      const indexParams = idxStmt['indexParams'];
      if (Array.isArray(indexParams)) {
        for (const p of indexParams) {
          if (!isRecord(p)) continue;
          const elem = getRecord(p, 'IndexElem');
          const colName = elem ? getString(elem, 'name') : undefined;
          if (colName) {
            const ordering = elem ? getString(elem, 'ordering') : undefined;
            const direction = ordering === 'SORTBY_DESC' ? 'desc' : 'asc';
            indexCols.push({
              name: colName,
              direction,
            });
          }
        }
      }

      let includeCols: string[] | undefined;
      const including = idxStmt['indexIncludingParams'];
      if (Array.isArray(including) && including.length > 0) {
        includeCols = [];
        for (const p of including) {
          if (!isRecord(p)) continue;
          const elem = getRecord(p, 'IndexElem');
          const colName = elem ? getString(elem, 'name') : undefined;
          if (colName) {
            includeCols.push(colName);
          }
        }
      }

      const existingIdx: ExistingIndex = {
        name: idxName,
        tableName,
        columns: indexCols,
        include: includeCols,
        isUnique: Boolean(idxStmt['unique']),
      };

      const targetTable = catalog.tables[tableName];
      if (targetTable) {
        targetTable.indexes.push(existingIdx);
      }
    }

    // 4. ALTER TABLE
    const alterStmt = getRecord(stmt, 'AlterTableStmt');
    if (alterStmt) {
      const rel = getRecord(alterStmt, 'relation');
      const tableName = rel ? (getString(rel, 'relname') ?? '') : '';
      const table = catalog.tables[tableName];

      if (table && Array.isArray(alterStmt['cmds'])) {
        for (const cmd of alterStmt['cmds']) {
          if (!isRecord(cmd)) continue;
          const alterCmd = getRecord(cmd, 'AlterTableCmd');
          if (!alterCmd) continue;

          const def = getRecord(alterCmd, 'def');
          const constraint = def ? getRecord(def, 'Constraint') : undefined;
          if (!constraint) continue;

          const contype = getString(constraint, 'contype') ?? '';

          if (contype === 'CONSTR_PRIMARY') {
            const keys = extractKeyNames(constraint['keys']);
            table.primaryKey = keys;
            for (const col of table.columns) {
              if (keys.includes(col.name)) {
                col.isPrimaryKey = true;
                col.nullable = false;
              }
            }
          } else if (contype === 'CONSTR_UNIQUE') {
            const keys = extractKeyNames(constraint['keys']);
            if (keys.length > 0) table.uniqueConstraints.push(keys);
          } else if (contype === 'CONSTR_FOREIGN') {
            const fkAttrs = extractKeyNames(constraint['fk_attrs']);
            const pkAttrs = extractKeyNames(constraint['pk_attrs']);
            const pktable = getRecord(constraint, 'pktable');
            const foreignTable = pktable ? (getString(pktable, 'relname') ?? '') : '';

            if (fkAttrs.length > 0 && foreignTable) {
              table.foreignKeys.push({
                column: fkAttrs[0]!,
                foreignTable,
                foreignColumn: pkAttrs[0] || 'id',
              });
            }
          }
        }
      }
    }
  }

  return catalog;
}
