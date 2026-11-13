/**
 * CI Guard: Check for orphaned service modules in backend/services/
 *
 * Ensures no service module under backend/services/ has zero importers across
 * routes/, models/, services/, tests/, or server.js.
 */

const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..', 'services');
const BACKEND_DIR = path.join(__dirname, '..');

// Recursively find all JS files in a directory
function getJsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        results = results.concat(getJsFiles(filePath));
      }
    } else if (file.endsWith('.js')) {
      results.push(filePath);
    }
  }
  return results;
}

const serviceFiles = getJsFiles(SERVICES_DIR);
const allBackendJsFiles = getJsFiles(BACKEND_DIR);

const orphaned = [];

for (const servicePath of serviceFiles) {
  const serviceBasename = path.basename(servicePath, '.js');
  const serviceRelPath = path.relative(BACKEND_DIR, servicePath).replace(/\\/g, '/');

  let importerCount = 0;

  for (const targetPath of allBackendJsFiles) {
    // Skip checking self
    if (path.resolve(targetPath) === path.resolve(servicePath)) continue;

    const content = fs.readFileSync(targetPath, 'utf8');
    if (content.includes(serviceBasename) || content.includes(serviceRelPath)) {
      importerCount++;
      break;
    }
  }

  if (importerCount === 0) {
    orphaned.push(serviceRelPath);
  }
}

if (orphaned.length > 0) {
  console.error('❌ CI Failure: The following service module(s) have 0 importers (orphaned code):');
  orphaned.forEach((file) => console.error(`   - ${file}`));
  process.exit(1);
} else {
  console.log(`✅ All ${serviceFiles.length} service modules under backend/services/ are imported and reachable.`);
  process.exit(0);
}
