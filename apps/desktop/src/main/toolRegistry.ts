/**
 * Phase 2.2: Tool Registry and Manifest
 *
 * Manages available tools, their definitions, and syncs manifest to phone.
 * Tools are registered with schemas, permission tiers, and metadata.
 */

import { ToolDefinition, PermissionTier, createBaseMessage } from '@vanessa/protocol';
import { EventEmitter } from 'events';
import crypto from 'crypto';

interface ToolImplementation {
  definition: ToolDefinition;
  handler: (args: any) => Promise<unknown>;
  enabled: boolean;
}

/**
 * Tool Registry - manages available tools and their implementations
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, ToolImplementation> = new Map();
  private manifestVersion: string = '';

  constructor() {
    super();
  }

  /**
   * Register a tool with its implementation
   */
  registerTool(
    definition: ToolDefinition,
    handler: (args: any) => Promise<unknown>
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool ${definition.name} already registered`);
    }

    this.tools.set(definition.name, {
      definition,
      handler,
      enabled: true,
    });

    // Update manifest version
    this.updateManifestVersion();

    console.log(`[Registry] Registered tool: ${definition.name} (${definition.tier})`);
    this.emit('tool-registered', { name: definition.name });
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.updateManifestVersion();
      console.log(`[Registry] Unregistered tool: ${name}`);
      this.emit('tool-unregistered', { name });
    }
    return removed;
  }

  /**
   * Get tool implementation
   */
  getTool(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool definitions (for manifest)
   */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.enabled)
      .map(tool => tool.definition);
  }

  /**
   * Check if tool exists and is enabled
   */
  isToolAvailable(name: string): boolean {
    const tool = this.tools.get(name);
    return tool !== undefined && tool.enabled;
  }

  /**
   * Enable/disable a tool
   */
  setToolEnabled(name: string, enabled: boolean): void {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    tool.enabled = enabled;
    this.updateManifestVersion();
    console.log(`[Registry] Tool ${name} ${enabled ? 'enabled' : 'disabled'}`);
    this.emit('tool-state-changed', { name, enabled });
  }

  /**
   * Execute a tool with arguments
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    if (!tool.enabled) {
      throw new Error(`Tool ${name} is disabled`);
    }

    // Validate arguments against schema
    this.validateArguments(tool.definition, args);

    // Execute with timeout
    const timeoutMs = tool.definition.timeout * 1000;
    const result = await this.executeWithTimeout(
      tool.handler(args),
      timeoutMs,
      `Tool ${name} execution timed out after ${tool.definition.timeout}s`
    );

    return result;
  }

  /**
   * Validate arguments against tool schema
   */
  private validateArguments(definition: ToolDefinition, args: Record<string, unknown>): void {
    const schema = definition.argsSchema;

    // Basic validation - check required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (!(required in args)) {
          throw new Error(`Missing required argument: ${required}`);
        }
      }
    }

    // Type validation for properties
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, value] of Object.entries(args)) {
        if (!(key in schema.properties)) {
          throw new Error(`Unknown argument: ${key}`);
        }
      }
    }
  }

  /**
   * Execute promise with timeout
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Get current manifest version
   */
  getManifestVersion(): string {
    return this.manifestVersion;
  }

  /**
   * Generate manifest sync message
   */
  generateManifestMessage() {
    return {
      ...createBaseMessage(),
      type: 'manifest.sync' as const,
      manifestVersion: this.manifestVersion,
      tools: this.getAllDefinitions(),
    };
  }

  /**
   * Update manifest version (hash of all tool definitions)
   */
  private updateManifestVersion(): void {
    const definitions = this.getAllDefinitions();
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(definitions));
    this.manifestVersion = hash.digest('hex').substring(0, 16);
  }

  /**
   * Get tool count
   */
  getToolCount(): number {
    return this.tools.size;
  }

  /**
   * Get enabled tool count
   */
  getEnabledToolCount(): number {
    return Array.from(this.tools.values()).filter(t => t.enabled).length;
  }

  /**
   * Get tools by permission tier
   */
  getToolsByTier(tier: PermissionTier): ToolDefinition[] {
    return this.getAllDefinitions().filter(def => def.tier === tier);
  }
}

/**
 * Helper to create tool definition
 */
export function createToolDefinition(
  name: string,
  description: string,
  argsSchema: Record<string, unknown>,
  tier: PermissionTier,
  options: {
    idempotent?: boolean;
    timeout?: number;
  } = {}
): ToolDefinition {
  return {
    name,
    description,
    argsSchema,
    tier,
    idempotent: options.idempotent ?? false,
    timeout: options.timeout ?? 30,
  };
}
