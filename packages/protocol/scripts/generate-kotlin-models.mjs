#!/usr/bin/env node

/**
 * Kotlin data class generator for Vanessa Protocol
 *
 * Reads schema/protocol-v1.schema.json and emits a sealed-class hierarchy
 * into apps/android/core/protocol/src/main/kotlin/com/vanessa/mobile/protocol/.
 *
 * The generated models are produced from the same JSON Schema the PC validates
 * against, so the two sides cannot drift. Hand-maintained Kotlin models are a
 * bug. Output must compile under Kotlin 1.9 with kotlinx.serialization, which
 * is why free-form JSON maps to JsonObject/JsonArray instead of `Any`.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, '..');
const ROOT = join(__dirname, '..', '..', '..');
const SCHEMA_PATH = join(PKG, 'schema', 'protocol-v1.schema.json');
const OUT_DIR = join(ROOT, 'apps', 'android', 'core', 'protocol', 'src', 'main', 'kotlin', 'com', 'vanessa', 'mobile', 'protocol');

/** Follow a local `$ref` to the schema node it points at. */
function resolveRef(prop, schema) {
  let node = prop;
  let guard = 0;
  while (node && typeof node.$ref === 'string' && guard++ < 20) {
    const path = node.$ref.replace(/^#\//, '').split('/');
    node = path.reduce((acc, key) => (acc == null ? acc : acc[key]), schema);
  }
  return node ?? {};
}

/** Map a JSON Schema property to a Kotlin type that can be serialized. */
function kotlinType(prop, schema) {
  const node = resolveRef(prop, schema);
  if (node.anyOf || node.oneOf) {
    const candidates = node.anyOf ?? node.oneOf;
    const concrete = candidates.find((item) => item.type !== 'null');
    return concrete ? kotlinType(concrete, schema) : 'JsonElement';
  }
  if (node.const !== undefined) return typeof node.const === 'number' ? 'Int' : 'String';
  if (Array.isArray(node.type)) {
    const first = node.type.find((t) => t !== 'null');
    return first ? kotlinType({ type: first }, schema) : 'JsonElement';
  }
  switch (node.type) {
    case 'string': return 'String';
    case 'integer': return 'Long';
    case 'number': return 'Double';
    case 'boolean': return 'Boolean';
    case 'object': return 'JsonObject';
    case 'array': return 'JsonArray';
    default: return 'JsonElement';
  }
}

function toClassName(typeConst) {
  return typeConst
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
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
  lines.push('import kotlinx.serialization.json.JsonArray');
  lines.push('import kotlinx.serialization.json.JsonElement');
  lines.push('import kotlinx.serialization.json.JsonObject');
  lines.push('');
  lines.push('/** Protocol version. Must match packages/protocol/src/protocol.ts. */');
  lines.push('const val PROTOCOL_VERSION: Int = 1');
  lines.push('');
  lines.push('/**');
  lines.push(' * Discriminated union over all message types the phone <-> PC link carries.');
  lines.push(' * The `type` field is the discriminator; the PC validates inbound messages');
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

    lines.push('/**');
    lines.push(` * ${typeConst} message.`);
    lines.push(' */');
    lines.push('@Serializable');
    lines.push(`@SerialName("${typeConst}")`);
    lines.push(`data class ${className}(`);

    const fields = [];
    for (const [name, prop] of Object.entries(props)) {
      if (name === 'type') continue;
      if (name === 'v') {
        fields.push('    @SerialName("v") override val v: Int');
        continue;
      }
      if (name === 'timestamp') {
        fields.push('    @SerialName("timestamp") override val timestamp: Long');
        continue;
      }
      const isOverride = name === 'id';
      const type = kotlinType(prop, schema);
      const optional = !required.has(name);
      const declaration = isOverride ? 'override val' : 'val';
      fields.push(`    @SerialName("${name}") ${declaration} ${name}: ${type}${optional ? '? = null' : ''}`);
    }

    lines.push(fields.join(',\n'));
    lines.push(') : VanessaProtocolMessage() {');
    lines.push(`    override val type: String = "${typeConst}"`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
const code = generate(schema);
mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, 'ProtocolModels.kt');
writeFileSync(outFile, code, 'utf-8');
console.log(`✅ Generated Kotlin models: ${outFile}`);
