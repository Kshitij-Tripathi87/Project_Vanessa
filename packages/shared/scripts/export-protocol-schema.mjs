import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { toJsonSchema } from "../dist/protocol.js";

const destination = resolve(import.meta.dirname, "../schema/protocol-v1.schema.json");
await writeFile(destination, `${JSON.stringify(toJsonSchema(), null, 2)}\n`, "utf8");
