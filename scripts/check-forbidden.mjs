import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const CHECKS = [
  {
    id: 'deprecated-sdk',
    description: 'Do not import deprecated @google/generative-ai',
    regex: /@google\/generative-ai/,
    fileFilter: (f) =>
      f.startsWith('src/') || f.startsWith('scripts/') || f.includes('bad-sample.ts'),
  },
  {
    id: 'pglite-instantiation-leak',
    description: 'new PGlite() must only exist in worker, engine, or spike script',
    regex: /new\s+PGlite\s*\(/,
    fileFilter: (f) =>
      (f.startsWith('src/') || f.includes('bad-sample.ts')) &&
      !f.includes('sandbox/worker.ts') &&
      !f.includes('sandbox/engine.ts'),
  },
  {
    id: 'eval-forbidden',
    description: 'eval() and new Function are strictly forbidden',
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    fileFilter: (f) => f.startsWith('src/') || f.includes('bad-sample.ts'),
  },
  {
    id: 'dangerouslySetInnerHTML',
    description: 'dangerouslySetInnerHTML is strictly forbidden',
    regex: /dangerouslySetInnerHTML/,
    fileFilter: (f) => f.startsWith('src/') || f.includes('bad-sample.ts'),
  },
  {
    id: 'localStorage-boundary',
    description: 'localStorage must only be accessed inside client/state/history.ts',
    regex: /\blocalStorage\b/,
    fileFilter: (f) =>
      (f.startsWith('src/') || f.includes('bad-sample.ts')) &&
      !f.includes('client/state/history.ts') &&
      !f.includes('client/state/history.test.ts'),
  },
  {
    id: 'forbidden-llm-params',
    description: 'Forbidden LLM parameters (temperature, topP, candidateCount, etc.)',
    regex: /\b(temperature|topP|top_p|topK|top_k|candidateCount|thinkingBudget|thinking_budget)\b/,
    fileFilter: (f) => f.startsWith('src/server/') || f.includes('bad-sample.ts'),
  },
  {
    id: 'console-in-server',
    description: 'console.* in src/server is forbidden (use logger.ts)',
    regex: /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/,
    fileFilter: (f) => f.startsWith('src/server/') || f.includes('bad-sample.ts'),
  },
  {
    id: 'hardcoded-secrets',
    description: 'Potential Google API key committed in code',
    regex: /AIza[0-9A-Za-z_-]{35}/,
    fileFilter: (f) => !f.endsWith('.env.example') && !f.startsWith('.git/'),
  },
  {
    id: 'ts-ignore-nocheck',
    description: '@ts-ignore and @ts-nocheck are forbidden',
    regex: /\/\/\s*@ts-(ignore|nocheck)\b/,
    fileFilter: (f) => f.startsWith('src/') || f.startsWith('tests/'),
  },
  {
    id: 'unexplained-suppression',
    description: 'Lint disable comments must include a reason (-- <reason>)',
    regex: /\/\/\s*(oxlint|eslint)-disable.*$/,
    fileFilter: (f) => f.startsWith('src/') || f.includes('bad-sample.ts'),
    customCheck: (content) => {
      const lines = content.split('\n');
      const violations = [];
      lines.forEach((line, idx) => {
        if (/\/\/\s*(oxlint|eslint)-disable/.test(line)) {
          if (!line.includes('--')) {
            violations.push({ line: idx + 1, text: line.trim() });
          }
        }
      });
      return violations;
    },
  },
  {
    id: 'todo-without-issue',
    description: 'TODO comments must reference an issue: TODO(#<id>)',
    regex: /\bTODO\b(?!\(#[0-9]+\))/,
    fileFilter: (f) =>
      f.startsWith('src/') || f.startsWith('scripts/') || f.includes('bad-sample.ts'),
  },
];

function getAllFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath).replace(/\\/g, '/');
    if (
      relPath.startsWith('node_modules') ||
      relPath.startsWith('.git') ||
      relPath.startsWith('dist') ||
      relPath.startsWith('.agent') ||
      relPath.startsWith('tests/fixtures/forbidden') ||
      relPath === 'scripts/check-forbidden.mjs'
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      fileList.push(relPath);
    }
  }
  return fileList;
}

export function runForbiddenCheck(files = getAllFiles(ROOT)) {
  const errors = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }

    for (const check of CHECKS) {
      if (!check.fileFilter(file)) continue;

      if (check.customCheck) {
        const customViolations = check.customCheck(content);
        for (const v of customViolations) {
          errors.push({
            file,
            line: v.line,
            id: check.id,
            description: check.description,
            snippet: v.text,
          });
        }
      } else if (check.regex.test(content)) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (check.regex.test(line)) {
            errors.push({
              file,
              line: idx + 1,
              id: check.id,
              description: check.description,
              snippet: line.trim(),
            });
          }
        });
      }
    }
  }

  return errors;
}

// Self-test runner if called with --self-test
if (process.argv.includes('--self-test')) {
  console.log('Running check-forbidden self-test...');
  const fixtureDir = path.join(ROOT, 'tests/fixtures/forbidden');
  if (!fs.existsSync(fixtureDir)) fs.mkdirSync(fixtureDir, { recursive: true });

  const testFile = path.join(fixtureDir, 'bad-sample.ts');
  fs.writeFileSync(
    testFile,
    `
    // bad-sample
    import '@google/generative-ai';
    eval('1+1');
    const x = localStorage;
    const temp = { temperature: 0.7 };
    console.log('leak');
    // @ts-ignore
    // oxlint-disable-next-line
    // TODO fix this
  `,
  );

  const errors = runForbiddenCheck(['tests/fixtures/forbidden/bad-sample.ts'.replace(/\\/g, '/')]);
  fs.rmSync(testFile, { force: true });

  if (errors.length >= 7) {
    console.log(`Self-test passed! Successfully caught ${errors.length} forbidden patterns.`);
    process.exit(0);
  } else {
    console.error(`Self-test failed: only caught ${errors.length} patterns.`);
    process.exit(1);
  }
}

// Main execution
const violations = runForbiddenCheck();
if (violations.length > 0) {
  console.error('\n❌ check-forbidden failed with violations:\n');
  violations.forEach((v) => {
    console.error(`  [${v.id}] ${v.file}:${v.line} - ${v.description}`);
    console.error(`    ${v.snippet}\n`);
  });
  process.exit(1);
} else {
  console.log('✓ check-forbidden passed (0 violations)');
}
