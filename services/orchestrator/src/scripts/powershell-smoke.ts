import { readFile } from 'node:fs/promises';
import { executePowerShellSteps } from '../agents/powershell-executor.js';

try {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error('Usage: pnpm smoke:powershell <request.json>');
  const result = await executePowerShellSteps(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, error: (error as Error).message }));
  process.exitCode = 1;
}
