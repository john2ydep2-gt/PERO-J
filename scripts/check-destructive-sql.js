#!/usr/bin/env node

/**
 * Migration & SQL Safety Gate: Block Destructive SQL Statements from Merging into Main
 *
 * Rules:
 * - DROP TABLE is blocked.
 * - DROP DATABASE is blocked.
 * - DROP COLUMN is blocked.
 * - Column type mutations (ALTER TABLE ... ALTER/MODIFY COLUMN ... TYPE) are blocked.
 * - TRUNCATE TABLE is blocked.
 */

const fs = require('fs');
const path = require('path');

const DESTRUCTIVE_RULES = [
  {
    name: 'DROP TABLE',
    regex: /\bDROP\s+TABLE\b/i,
    message: 'DROP TABLE statements cause irreversible data loss and are blocked from merging into main.',
  },
  {
    name: 'DROP DATABASE',
    regex: /\bDROP\s+DATABASE\b/i,
    message: 'DROP DATABASE statements are completely destructive and blocked.',
  },
  {
    name: 'DROP COLUMN',
    regex: /\bALTER\s+TABLE\s+[\w\.]+\s+DROP\s+(?:COLUMN\s+)?/i,
    message: 'Direct DROP COLUMN breaks running instances. Use expand/contract phased deprecation instead.',
  },
  {
    name: 'COLUMN TYPE CHANGE',
    regex: /\bALTER\s+TABLE\s+[\w\.]+\s+(?:ALTER|MODIFY)\s+(?:COLUMN\s+)?[\w\.]+\s+(?:TYPE\s+|SET\s+DATA\s+TYPE\s+|VARCHAR|INT|BIGINT|TEXT|TIMESTAMP|JSON)/i,
    message: 'Direct column type modification requires full table lock and table rewrite. Blocked from merging into main.',
  },
  {
    name: 'TRUNCATE',
    regex: /\bTRUNCATE\s+(?:TABLE\s+)?/i,
    message: 'TRUNCATE statements purge table data and are blocked from merging into main.',
  },
];

function checkSql(sqlText, filePath) {
  const violations = [];
  const lines = sqlText.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (line.startsWith('--') || line.startsWith('//') || line.startsWith('/*')) continue;

    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.regex.test(line)) {
        violations.push({
          file: filePath,
          line: lineNum + 1,
          rule: rule.name,
          statement: line,
          message: rule.message,
        });
      }
    }
  }

  return violations;
}

function scanFiles() {
  const rootDir = path.resolve(__dirname, '..');
  console.log(`[Safety Gate] Scanning codebase for destructive SQL statements in ${rootDir}...`);

  const targets = [
    path.join(rootDir, 'indexer/src/db.js'),
    path.join(rootDir, 'indexer/src/db.ts'),
  ];

  const allViolations = [];

  for (const target of targets) {
    if (fs.existsSync(target)) {
      const content = fs.readFileSync(target, 'utf8');
      const violations = checkSql(content, path.relative(rootDir, target));
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    console.error('\n======================================================');
    console.error('❌ SQL SAFETY GATE: DESTRUCTIVE STATEMENTS DETECTED');
    console.error('======================================================');
    for (const v of allViolations) {
      console.error(`- [${v.rule}] File: ${v.file}:${v.line}`);
      console.error(`  Statement: "${v.statement}"`);
      console.error(`  Policy: ${v.message}\n`);
    }
    console.error('Destructive SQL statements are strictly blocked from merging into main.');
    console.error('Please refactor using backward-compatible, expand/contract migrations.');
    process.exit(1);
  } else {
    console.log('✅ [SQL Safety Gate Passed] No destructive SQL statements detected.');
    process.exit(0);
  }
}

if (require.main === module) {
  scanFiles();
}

module.exports = { checkSql, DESTRUCTIVE_RULES };
