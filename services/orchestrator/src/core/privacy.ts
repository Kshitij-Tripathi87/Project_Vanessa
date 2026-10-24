import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export interface RedactionResult {
  cleanText: string;
  redactedCount: number;
  redactedTypes: string[];
}

export class PrivacyGuard {
  private allowedFolders: Set<string> = new Set();
  private defaultFolder: string;

  constructor() {
    this.defaultFolder = path.resolve(os.homedir(), "Documents", "VanessaDemo");
    try {
      if (!fs.existsSync(this.defaultFolder)) {
        fs.mkdirSync(this.defaultFolder, { recursive: true });
      }
    } catch {
      // Fallback to local workspace if Documents is restricted
      this.defaultFolder = path.resolve(process.cwd(), "VanessaDemo");
      if (!fs.existsSync(this.defaultFolder)) {
        fs.mkdirSync(this.defaultFolder, { recursive: true });
      }
    }
    this.allowedFolders.add(this.defaultFolder);
    // Also allow current workspace incident lab if running
    this.allowedFolders.add(path.resolve(process.cwd()));
    // Add the detected monorepo root as an explicit approved workspace when launched from a child package.
    let workspaceCandidate = path.resolve(process.cwd());
    while (true) {
      if (fs.existsSync(path.join(workspaceCandidate, "pnpm-workspace.yaml"))) {
        try { this.allowedFolders.add(fs.realpathSync(workspaceCandidate)); } catch { /* retain existing approved roots */ }
        break;
      }
      const parent = path.dirname(workspaceCandidate);
      if (parent === workspaceCandidate) break;
      workspaceCandidate = parent;
    }
  }

  getAllowedFolders(): string[] {
    return Array.from(this.allowedFolders);
  }

  addAllowedFolder(folderPath: string): boolean {
    const resolved = path.resolve(folderPath);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        this.allowedFolders.add(resolved);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  isPathAllowed(targetPath: string): boolean {
    try {
      const resolved = this.resolvePhysicalPath(targetPath);
      for (const allowedPath of this.allowedFolders) {
        const allowed = this.resolvePhysicalPath(allowedPath);
        const relative = path.relative(allowed, resolved);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private resolvePhysicalPath(targetPath: string): string {
    let candidate = path.resolve(targetPath);
    const suffix: string[] = [];

    while (!fs.existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("Path has no existing ancestor");
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }

    const realAncestor = fs.realpathSync.native(candidate);
    return path.resolve(realAncestor, ...suffix);
  }

  /**
   * Local redaction layer: Removes API keys, tokens, passwords, emails,
   * phone numbers, and card-like numbers before writing to persistent memory.
   */
  redactSensitiveData(text: string): RedactionResult {
    let clean = text;
    let redactedCount = 0;
    const types: string[] = [];

    // 1. API Keys and Tokens
    const apiKeyPatterns = [
      /\b(nvapi-[A-Za-z0-9_-]{20,})\b/g,
      /\b(sk-[A-Za-z0-9]{20,})\b/g,
      /\b(ghp_[A-Za-z0-9]{20,})\b/g,
      /Bearer\s+([A-Za-z0-9._~+/-]{20,})/gi,
      /(api[_-]?key\s*[:=]\s*["']?)([A-Za-z0-9_\-]{16,})(["']?)/gi,
    ];

    for (const pat of apiKeyPatterns) {
      if (pat.test(clean)) {
        clean = clean.replace(pat, (match, p1, p2) => {
          redactedCount++;
          if (!types.includes("API_KEY")) types.push("API_KEY");
          return p2 ? `${p1}[REDACTED_API_KEY]` : "[REDACTED_API_KEY]";
        });
      }
    }

    // 2. Passwords / Secrets
    const passwordPat = /(password|passwd|secret)\s*[:=]\s*["']?([^\s"']+)["']?/gi;
    if (passwordPat.test(clean)) {
      clean = clean.replace(passwordPat, (_match, p1) => {
        redactedCount++;
        if (!types.includes("PASSWORD")) types.push("PASSWORD");
        return `${p1}: [REDACTED_PASSWORD]`;
      });
    }

    // 3. Email Addresses
    const emailPat = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    if (emailPat.test(clean)) {
      clean = clean.replace(emailPat, () => {
        redactedCount++;
        if (!types.includes("EMAIL")) types.push("EMAIL");
        return "[REDACTED_EMAIL]";
      });
    }

    // 4. Phone Numbers (international and domestic formats)
    const phonePat = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
    if (phonePat.test(clean)) {
      clean = clean.replace(phonePat, () => {
        redactedCount++;
        if (!types.includes("PHONE")) types.push("PHONE");
        return "[REDACTED_PHONE]";
      });
    }

    // 5. Credit Card / 16-digit financial numbers
    const cardPat = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
    if (cardPat.test(clean)) {
      clean = clean.replace(cardPat, () => {
        redactedCount++;
        if (!types.includes("CARD")) types.push("CARD");
        return "[REDACTED_CARD]";
      });
    }

    return {
      cleanText: clean,
      redactedCount,
      redactedTypes: types,
    };
  }

  getPrivacyStatus() {
    return {
      localMemory: "active (SQLite/Rust 127.0.0.1)",
      cloudVoice: process.env.VOICE_TTS_PROVIDER || process.env.VOICE_PROVIDER || "Fish Audio",
      folderPolicy: "only approved folders",
      allowedFolders: this.getAllowedFolders(),
      localRedactionActive: true,
      orchestratorHost: "127.0.0.1",
      networkBoundToLocal: true,
    };
  }
}

export const privacyGuard = new PrivacyGuard();
