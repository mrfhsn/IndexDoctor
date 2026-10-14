import { AppError } from '../errors.js';
import { type Catalog, buildCatalog } from './catalog.js';
import { type ParsedStatement, parseSql } from './parse.js';
import { sanitizeMysql } from './sanitize-mysql.js';

export interface GateResult {
  statements: string[];
  querySql: string;
  catalog: Catalog;
  notices: string[];
  queryAst: ParsedStatement;
  referencedTables: Set<string>;
}

const MAX_SCHEMA_BYTES = 20000;
const MAX_QUERY_BYTES = 8000;
const MAX_TABLES = 30;
const MAX_COLUMNS_PER_TABLE = 100;
const MAX_STATEMENTS = 100;

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const DENIED_FUNCTIONS = new Set([
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'lo_import',
  'lo_export',
  'dblink',
  'dblink_exec',
  'set_config',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'query_to_xml',
]);

const ALLOWED_DDL_FUNCTIONS = new Set([
  'now',
  'current_timestamp',
  'gen_random_uuid',
  'uuid_generate_v4',
  'nextval',
  'lower',
  'upper',
  'coalesce',
  'length',
  'trim',
]);

function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new AppError(
      'UNSUPPORTED_SQL',
      `Invalid identifier "${name}" in ${context}. Identifiers must use simple ASCII letters, numbers, and underscores (max 63 chars).`,
      {
        status: 422,
        hint: 'Use simple standard identifiers matching ^[A-Za-z_][A-Za-z0-9_]{0,62}$',
      },
    );
  }
}

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

/**
 * Traverses an AST object to find all function calls and relation references.
 */
function inspectQueryAst(
  node: unknown,
  state: {
    referencedTables: Set<string>;
    cteNames: Set<string>;
  },
): void {
  if (!isRecord(node)) return;

  const obj = node;

  // Check CTE names in WITH clause
  const cte = getRecord(obj, 'CommonTableExpr');
  if (cte) {
    const cteName = getString(cte, 'ctename');
    if (cteName) {
      state.cteNames.add(cteName.toLowerCase());
    }
  }

  // Check RangeVar (table references)
  const rv = getRecord(obj, 'RangeVar');
  if (rv) {
    const schemaVal = getString(rv, 'schemaname');
    const relVal = getString(rv, 'relname');
    const schemaname = schemaVal ? schemaVal.toLowerCase() : '';
    const relname = relVal ? relVal.toLowerCase() : '';

    if (schemaname.startsWith('pg_') || schemaname === 'information_schema') {
      throw new AppError(
        'UNSUPPORTED_SQL',
        `Direct access to system schema "${schemaname}" is not permitted.`,
        {
          status: 422,
          hint: 'Query only application tables defined in the schema.',
        },
      );
    }

    if (relname.startsWith('pg_')) {
      throw new AppError(
        'UNSUPPORTED_SQL',
        `Direct access to system catalog "${relname}" is not permitted.`,
        {
          status: 422,
          hint: 'Query only application tables defined in the schema.',
        },
      );
    }

    if (relname) {
      state.referencedTables.add(relname);
    }
  }

  // Check FuncCall
  const fc = getRecord(obj, 'FuncCall');
  if (fc) {
    const names = fc['funcname'];
    if (Array.isArray(names) && names.length > 0) {
      const last = names[names.length - 1];
      let sval = '';
      if (isRecord(last)) {
        const svalDirect = getString(last, 'sval');
        const stringObj = getRecord(last, 'String');
        const svalNested = stringObj ? getString(stringObj, 'sval') : undefined;
        sval = svalDirect ?? svalNested ?? '';
      }
      const fnName = sval.toLowerCase();
      if (DENIED_FUNCTIONS.has(fnName)) {
        throw new AppError(
          'UNSUPPORTED_SQL',
          `Use of privileged/administrative function "${fnName}()" is forbidden.`,
          {
            status: 422,
            hint: 'Remove administrative or file/sleep functions from the query.',
          },
        );
      }
    }
  }

  // Recurse into children
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const child of val) {
        inspectQueryAst(child, state);
      }
    } else {
      inspectQueryAst(val, state);
    }
  }
}

/**
 * Validates DDL function calls against the allow-list.
 */
function validateDdlFunctions(node: unknown): void {
  if (!isRecord(node)) return;
  const obj = node;

  const fc = getRecord(obj, 'FuncCall');
  if (fc) {
    const names = fc['funcname'];
    if (Array.isArray(names) && names.length > 0) {
      const last = names[names.length - 1];
      let sval = '';
      if (isRecord(last)) {
        const svalDirect = getString(last, 'sval');
        const stringObj = getRecord(last, 'String');
        const svalNested = stringObj ? getString(stringObj, 'sval') : undefined;
        sval = svalDirect ?? svalNested ?? '';
      }
      const fnName = sval.toLowerCase();
      if (!ALLOWED_DDL_FUNCTIONS.has(fnName)) {
        throw new AppError(
          'UNSUPPORTED_SQL',
          `Function "${fnName}()" in DDL definition is not on the allowed functions list.`,
          {
            status: 422,
            hint: `Permitted DDL functions: ${Array.from(ALLOWED_DDL_FUNCTIONS).join(', ')}.`,
          },
        );
      }
    }
  }

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const child of val) validateDdlFunctions(child);
    } else {
      validateDdlFunctions(val);
    }
  }
}

/**
 * SQL Gate validator.
 * Validates schema and query against strict AST allow-lists, naming rules,
 * unknown table checks, and limits before any execution in the sandbox.
 */
export async function validateGate(schemaSql: string, querySql: string): Promise<GateResult> {
  // 1. Input length checks
  if (schemaSql.length > MAX_SCHEMA_BYTES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Schema exceeds maximum limit (${schemaSql.length} bytes > ${MAX_SCHEMA_BYTES})`,
      { status: 413, hint: 'Submit a schema under 20 KB.' },
    );
  }
  if (querySql.length > MAX_QUERY_BYTES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Query exceeds maximum limit (${querySql.length} bytes > ${MAX_QUERY_BYTES})`,
      { status: 413, hint: 'Submit a query under 8 KB.' },
    );
  }

  // 2. MySQL dialect sanitization
  const { sql: sanitizedSchema, notices: mysqlNotices } = sanitizeMysql(schemaSql);
  const notices = [...mysqlNotices];

  // 3. Parse Schema and Query
  const parsedSchema = await parseSql(sanitizedSchema);
  const parsedQuery = await parseSql(querySql);

  // 4. Validate Query structure
  if (parsedQuery.stmts.length !== 1) {
    throw new AppError('UNSUPPORTED_SQL', 'Query must contain exactly one SELECT statement.', {
      status: 422,
      hint: 'Remove multiple queries or trailing semicolons.',
    });
  }

  const queryStmtObj = parsedQuery.stmts[0]?.stmt;
  const selectStmt = isRecord(queryStmtObj) ? getRecord(queryStmtObj, 'SelectStmt') : undefined;
  if (!selectStmt) {
    throw new AppError(
      'UNSUPPORTED_SQL',
      'Only SELECT queries (including WITH ... SELECT) are supported.',
      {
        status: 422,
        hint: 'Provide an EXPLAIN-able SELECT query.',
      },
    );
  }

  if (selectStmt['intoClause']) {
    throw new AppError('UNSUPPORTED_SQL', 'SELECT INTO statements are not permitted.', {
      status: 422,
      hint: 'Use a pure SELECT query without creating a new table.',
    });
  }

  if (selectStmt['lockingClause']) {
    throw new AppError(
      'UNSUPPORTED_SQL',
      'Locking clauses (FOR UPDATE, FOR SHARE) are not permitted.',
      {
        status: 422,
        hint: 'Remove row-level locking clauses from the query.',
      },
    );
  }

  const queryInspection = {
    referencedTables: new Set<string>(),
    cteNames: new Set<string>(),
  };
  inspectQueryAst(selectStmt, queryInspection);

  // 5. Validate Schema statements against AST allow-list
  if (parsedSchema.stmts.length > MAX_STATEMENTS) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Schema contains too many statements (${parsedSchema.stmts.length} > ${MAX_STATEMENTS})`,
      { status: 413, hint: 'Limit schema to at most 100 statements.' },
    );
  }

  const validStmts: ParsedStatement[] = [];
  const runnableStatements: string[] = [];

  for (const parsedStmt of parsedSchema.stmts) {
    const stmt = parsedStmt.stmt;
    const stmtType = Object.keys(stmt)[0] || 'Unknown';

    // Check Ignored statements
    if (stmt['VariableSetStmt']) {
      notices.push('Ignored SET statement in schema.');
      continue;
    }
    if (stmt['CommentStmt']) {
      notices.push('Ignored COMMENT statement.');
      continue;
    }
    if (stmt['CreateExtensionStmt']) {
      notices.push('Ignored CREATE EXTENSION statement.');
      continue;
    }
    if (stmt['AlterOwnerStmt']) {
      notices.push('Ignored ALTER OWNER statement.');
      continue;
    }

    // Check Allowed statements
    const cstmt = getRecord(stmt, 'CreateStmt');
    if (cstmt) {
      const rel = getRecord(cstmt, 'relation');
      const tableName = rel ? (getString(rel, 'relname') ?? '') : '';
      validateIdentifier(tableName, 'table name');

      if (cstmt['inhRelations']) {
        throw new AppError('UNSUPPORTED_SQL', 'Table inheritance is not supported.', {
          status: 422,
          hint: 'Use flat tables without INHERITS.',
        });
      }

      const tableElts = cstmt['tableElts'];
      if (Array.isArray(tableElts)) {
        if (tableElts.length > MAX_COLUMNS_PER_TABLE) {
          throw new AppError(
            'PAYLOAD_TOO_LARGE',
            `Table "${tableName}" exceeds column limit (${tableElts.length} > ${MAX_COLUMNS_PER_TABLE})`,
            { status: 413, hint: 'Limit columns to 100 per table.' },
          );
        }

        for (const elt of tableElts) {
          if (isRecord(elt)) {
            const colDef = getRecord(elt, 'ColumnDef');
            const colName = colDef ? getString(colDef, 'colname') : undefined;
            if (colName) {
              validateIdentifier(colName, `column in table ${tableName}`);
            }
          }
        }
      }

      validateDdlFunctions(cstmt);
      validStmts.push(parsedStmt);

      // Extract statement text slice
      const loc = parsedStmt.stmt_location ?? 0;
      const len = parsedStmt.stmt_len ?? sanitizedSchema.length - loc;
      runnableStatements.push(sanitizedSchema.slice(loc, loc + len).trim());
      continue;
    }

    const enumStmt = getRecord(stmt, 'CreateEnumStmt');
    if (enumStmt) {
      const typeNames = enumStmt['typeName'];
      if (Array.isArray(typeNames) && typeNames.length > 0) {
        const last = typeNames[typeNames.length - 1];
        let sval = '';
        if (isRecord(last)) {
          const svalDirect = getString(last, 'sval');
          const stringObj = getRecord(last, 'String');
          const svalNested = stringObj ? getString(stringObj, 'sval') : undefined;
          sval = svalDirect ?? svalNested ?? '';
        }
        if (sval) validateIdentifier(sval, 'enum type name');
      }
      validStmts.push(parsedStmt);
      const loc = parsedStmt.stmt_location ?? 0;
      const len = parsedStmt.stmt_len ?? sanitizedSchema.length - loc;
      runnableStatements.push(sanitizedSchema.slice(loc, loc + len).trim());
      continue;
    }

    const idxStmt = getRecord(stmt, 'IndexStmt');
    if (idxStmt) {
      const idxName = getString(idxStmt, 'idxname');
      if (idxName) validateIdentifier(idxName, 'index name');
      const rel = getRecord(idxStmt, 'relation');
      const relName = rel ? getString(rel, 'relname') : undefined;
      if (relName) validateIdentifier(relName, 'index target table');

      validStmts.push(parsedStmt);
      const loc = parsedStmt.stmt_location ?? 0;
      const len = parsedStmt.stmt_len ?? sanitizedSchema.length - loc;
      runnableStatements.push(sanitizedSchema.slice(loc, loc + len).trim());
      continue;
    }

    const alterStmt = getRecord(stmt, 'AlterTableStmt');
    if (alterStmt) {
      const rel = getRecord(alterStmt, 'relation');
      const relName = rel ? getString(rel, 'relname') : undefined;
      if (relName) validateIdentifier(relName, 'alter table target');

      validStmts.push(parsedStmt);
      const loc = parsedStmt.stmt_location ?? 0;
      const len = parsedStmt.stmt_len ?? sanitizedSchema.length - loc;
      runnableStatements.push(sanitizedSchema.slice(loc, loc + len).trim());
      continue;
    }

    // Anything else is rejected
    throw new AppError(
      'UNSUPPORTED_SQL',
      `Statement type ${stmtType} is not permitted in schema. Only CREATE TABLE, CREATE INDEX, CREATE TYPE, and ALTER TABLE are allowed.`,
      {
        status: 422,
        hint: `Remove statement "${stmtType}". IndexDoctor does not allow data modifications, triggers, or procedure DDL.`,
      },
    );
  }

  // 6. Build Catalog
  const catalog = buildCatalog(validStmts);
  const tableCount = Object.keys(catalog.tables).length;
  if (tableCount > MAX_TABLES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Schema exceeds table limit (${tableCount} tables > ${MAX_TABLES})`,
      { status: 413, hint: 'Submit a schema with at most 30 tables.' },
    );
  }

  // 7. Validate that all query relations exist in the catalog (or are CTE names)
  const unknownTables: string[] = [];
  for (const tbl of queryInspection.referencedTables) {
    if (!catalog.tables[tbl] && !queryInspection.cteNames.has(tbl)) {
      unknownTables.push(tbl);
    }
  }

  if (unknownTables.length > 0) {
    throw new AppError(
      'UNSUPPORTED_SQL',
      `Query references unknown table(s): ${unknownTables.join(', ')}. Ensure all queried tables are defined in the schema.`,
      {
        status: 422,
        hint: `Available schema tables: ${Object.keys(catalog.tables).join(', ') || 'none'}.`,
      },
    );
  }

  const queryAst = parsedQuery.stmts[0]!;

  return {
    statements: runnableStatements,
    querySql,
    catalog,
    notices,
    queryAst,
    referencedTables: queryInspection.referencedTables,
  };
}
