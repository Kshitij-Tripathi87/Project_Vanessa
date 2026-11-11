#!/usr/bin/env node

/**
 * Kotlin data class generator for Vanessa Protocol
 *
 * Reads schema/protocol-v1.schema.json and emits a sealed-class hierarchy
 * into apps/android/core/protocol/src/main/kotlin/com/vanessa/mobile/protocol/.
 *
 * The generated models are the single source of truth for the Android side:
 * they are produced from the same JSON Schema the PC validates against, so
 * the two sides cannot drift. Hand-maintained Kotlin models are a bug.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at packages/protocol/scripts/. The protocol package root is
// one level up; the monorepo root is two levels up.
const PKG = join(__dirname, '..');
// Script: packages/protocol/scripts/ -> ../ = packages/protocol, ../../ = packages,
// ../../../ = monorepo root.
const ROOT = join(__dirname, '..', '..', '..');
const SCHEMA_PATH = join(PKG, 'schema', 'protocol-v1.schema.json');
const OUT_DIR = join(ROOT, 'apps', 'android', 'core', 'protocol', 'src', 'main', 'kotlin', 'com', 'vanessa', 'mobile', 'protocol');

/** Map a JSON Schema type to a Kotlin type name. */
function kotlinType(prop) {
  if (prop.$ref) {
    return prop.$ref.split('/').pop();
  }
  switch (prop.type) {
    case 'string': return 'String';
    case 'integer': return 'Long';
    case 'number': return 'Double';
    case 'boolean': return 'Boolean';
    case 'object': return 'Map<String, Any>';
    case 'array': return 'List<Any>';
    default: return 'Any';
  }
}

/** Map a JSON Schema type to a Kotlin default value. */
function defaultValue(prop) {
  if (prop.$ref) return 'null';
  switch (prop.type) {
    case 'string': return '""';
    case 'integer': return '0L';
    case 'number': return '0.0';
    case 'boolean': return 'false';
    case 'object': return 'emptyMap()';
    case 'array': return 'emptyList()';
    default: return 'null';
  }
}

function escapeDoc(s) {
  return (s || '').replace(/\*\//g, '*&#47;');
}

function generate(schema) {
  const variants = schema.definitions.VanessaProtocolMessage.anyOf;
  const lines = [];

  lines.push('/**');
  lines.push(' * Auto-generated from protocol-v1.schema.json.');
  lines.push(' * DO NOT EDIT BY HAND — regenerate with');
  lines.push(' *   pnpm --filter @vanessa/protocol build');
  lines.push(' */');
  lines.push('package com.vanessa.mobile.protocol');
  lines.push('');
  lines.push('import kotlinx.serialization.SerialName');
  lines.push('import kotlinx.serialization.Serializable');
  lines.push('');
  lines.push('/**');
  lines.push(' * Protocol version. Must match packages/protocol/src/protocol.ts.');
  lines.push(' */');
  lines.push('const val PROTOCOL_VERSION: Int = 1');
  lines.push('');
  lines.push('/**');
  lines.push(' * Discriminated union over all message types the phone <-> PC link carries.');
  lines.push(' *');
  lines.push(' * The `type` field is the discriminator. The PC validates inbound messages');
  lines.push(' * against the same schema, so the two sides cannot drift.');
  lines.push(' */');
  lines.push('@Serializable');
  lines.push('sealed class VanessaProtocolMessage {');
  lines.push('    abstract val v: Int');
  lines.push('    abstract val id: String');
  lines.push('    abstract val timestamp: Long');
  lines.push('    abstract val type: String');
  lines.push('');
  lines.push('    companion object {');
  lines.push('        const val VERSION: Int = PROTOCOL_VERSION');
  lines.push('    }');
  lines.push('}');
  lines.push('');

  for (const variant of variants) {
    const props = variant.properties;
    const typeConst = props.type.const;
    const className = toClassName(typeConst);
    const required = new Set(variant.required || []);
    const optional = Object.keys(props).filter(k => !required.has(k) && k !== 'type');

    lines.push('/**');
    lines.push(` * ${typeConst} message.`);
    lines.push(' */');
    lines.push('@Serializable');
    lines.push(`data class ${className}(`);

    const fields = [];
    for (const [name, prop] of Object.entries(props)) {
      if (name === 'type') continue;
      const t = kotlinType(prop);
      const serialName = name === 'v' ? 'v' : name;
      const defaultVal = required.has(name) ? '' : ` = ${defaultValue(prop)}`;
      fields.push(`    @SerialName("${serialName}") val ${name}: ${t}${defaultVal}`);
    }
    lines.push(fields.join(',\n'));
    lines.push(') : VanessaProtocolMessage() {');
    lines.push(`    override val v: Int = PROTOCOL_VERSION`);
    lines.push(`    override val type: String = "${typeConst}"`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

function toClassName(typeConst) {
  return typeConst
    .split('.')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function main() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  const code = generate(schema);

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, 'ProtocolModels.kt');
  writeFileSync(outFile, code, 'utf-8');

  console.log(`✅ Generated Kotlin models: ${outFile}`);
}

main();