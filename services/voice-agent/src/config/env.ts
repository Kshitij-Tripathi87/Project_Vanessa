import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Load before dependencies construct their session/client singletons.
if (process.env.VANESSA_SKIP_DOTENV !== "true") dotenv.config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
