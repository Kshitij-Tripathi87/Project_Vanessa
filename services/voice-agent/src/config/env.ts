import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Load before dependencies construct their session/client singletons.
dotenv.config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
