// The surfaces the CLI registers, generated from its own command table, for the X-ray's --inventory. The dispatcher's
// own list is checked against this table in test/cli-table.test.mjs, so the two cannot drift apart.
//   node scripts/inventory.mjs > inventory.json
import { COMMAND_WORDS } from '../src/cli-table.mjs';

process.stdout.write(`${JSON.stringify({ cli: COMMAND_WORDS }, null, 2)}\n`);
