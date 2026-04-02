/**
 * Single source of truth for version.
 * Reads from package.json at runtime.
 */
import { join, dirname } from "bun:path";
import { homedir } from "bun:os";

// Bun-safe way to get __dirname in ESM
const __filename = import.meta.url.replace("file://", "");
const __dirname = dirname(__filename);

// Read package.json at runtime (go up one level from dist to project root)
const pkgPath = join(__dirname, "..", "package.json");
const pkg = await import("bun:fs").then(m => m.readFileSync(pkgPath, "utf-8")).then(JSON.parse) as { version: string };

export const VERSION = pkg.version;
export const USER_AGENT = `clawrouter/${VERSION}`;
