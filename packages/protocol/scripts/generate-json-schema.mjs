import { toJsonSchema } from "../dist/protocol.js";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = `${__dirname}/../schema`;

// Ensure schema directory exists
mkdirSync(schemaDir, { recursive: true });

// Generate JSON Schema
const schema = toJsonSchema();
const schemaPath = `${schemaDir}/protocol-v1.schema.json`;

writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

console.log(`✅ Generated JSON Schema: ${schemaPath}`);
