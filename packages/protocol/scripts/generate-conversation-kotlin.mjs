#!/usr/bin/env node
/**
 * Generate Kotlin models AND validation rules from conversation-v1.schema.json.
 * Fail closed on schema constructs we do not understand: silently mapping a new
 * constraint to String would make Kotlin a weaker, drifting wire contract.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const pkg = join(dir, '..');
const root = join(pkg, '..', '..');
const schema = JSON.parse(readFileSync(join(pkg, 'schema', 'conversation-v1.schema.json'), 'utf8'));
const definitions = schema.definitions;
const out = join(root, 'apps', 'android', 'core', 'protocol', 'src', 'main', 'kotlin', 'com', 'vanessa', 'protocol', 'conversation', 'ConversationModels.kt');

function check(condition, message) {
  if (!condition) throw new Error(`Conversation schema: ${message}`);
}
function quote(s) {
  check(typeof s === 'string', 'expected string');
  // JSON-style quoted strings are Kotlin-compatible for these schema values;
  // dollar signs must additionally be escaped to prevent Kotlin interpolation.
  return JSON.stringify(s).replaceAll('$', '\\$');
}
function identifier(s) {
  check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(s), `unsupported identifier ${s}`);
  check(!new Set(['class', 'object', 'when', 'is', 'in', 'val', 'var', 'typealias', 'final']).has(s), `reserved identifier ${s}`);
  return s;
}
function enumConstant(value) {
  const result = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  check(/^[A-Z_][A-Z0-9_]*$/.test(result), `unsupported enum value ${value}`);
  return result;
}
function className(value) {
  return value.split(/[._-]/).map((part) => part[0].toUpperCase() + part.slice(1)).join('') + 'Event';
}

check(schema.$schema === 'http://json-schema.org/draft-07/schema#', 'unsupported JSON Schema dialect');
check(schema.$ref === '#/definitions/ConversationEvent', 'unexpected root');
check(Number.isSafeInteger(schema['x-vanessa-protocolVersion']), 'missing protocol version');
check(Number.isSafeInteger(schema['x-vanessa-maxConversationTurns']), 'missing history bound');
const events = definitions.ConversationEvent?.anyOf;
check(Array.isArray(events) && events.length > 0, 'event union is missing');
const enumDefinitions = Object.entries(definitions).filter(([, value]) => value.type === 'string' && Array.isArray(value.enum));
const enumMap = new Map(enumDefinitions.map(([name, value]) => [JSON.stringify(value.enum), identifier(name)]));
check(enumMap.size === enumDefinitions.length, 'ambiguous enum definitions');

const fieldKeywords = new Set(['type', 'format', 'pattern', 'const', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'x-vanessa-minUtf16Length', 'x-vanessa-maxUtf16Length']);
function inspectObject(object, name) {
  check(object?.type === 'object' && object.additionalProperties === false, `${name} must be strict object`);
  check(Object.keys(object).every((key) => ['type', 'properties', 'required', 'additionalProperties'].includes(key)), `${name} uses unsupported object constraints`);
  check(object.properties && Array.isArray(object.required), `${name} is missing properties/required`);
  for (const required of object.required) check(required in object.properties, `${name} required property is missing`);
  for (const [field, prop] of Object.entries(object.properties)) {
    identifier(field);
    check(Object.keys(prop).every((key) => fieldKeywords.has(key)), `${name}.${field} uses unsupported constraint`);
    check(prop.type === 'string' || prop.type === 'integer', `${name}.${field} has unsupported type`);
    if (prop.format !== undefined) check(prop.format === 'uuid', `${name}.${field} has unsupported format`);
    if (prop.pattern !== undefined) check(prop.pattern === '^[0-9a-f-]+$', `${name}.${field} has an unreviewed regex dialect`);
    if (prop.enum) check(enumMap.has(JSON.stringify(prop.enum)), `${name}.${field} has no named enum`);
    if (prop.minLength !== undefined) check(prop['x-vanessa-minUtf16Length'] === prop.minLength, `${name}.${field} lacks UTF-16 minimum`);
    if (prop.maxLength !== undefined) check(prop['x-vanessa-maxUtf16Length'] === prop.maxLength, `${name}.${field} lacks UTF-16 maximum`);
    for (const key of ['minLength', 'maxLength', 'minimum', 'maximum']) {
      if (prop[key] !== undefined) check(Number.isSafeInteger(prop[key]), `${name}.${field} ${key} is not a safe integer`);
    }
  }
}
for (const event of events) {
  const type = event.properties?.type?.const;
  check(typeof type === 'string' && event.required?.includes('type'), 'event discriminator must be required');
  inspectObject(event, type);
  for (const key of ['conversationId', 'turnId']) check(event.required.includes(key), `${type}.${key} must be required`);
}
check(new Set(events.map((event) => event.properties.type.const)).size === events.length, 'duplicate event type');
inspectObject(definitions.ConversationSession, 'ConversationSession');
inspectObject(definitions.ConversationTurn, 'ConversationTurn');
const byType = new Map(events.map((event) => [event.properties.type.const, event]));
const turnMax = definitions.ConversationTurn.properties.content.maxLength;
const chunkMax = byType.get('response.chunk')?.properties.text.maxLength;
check(turnMax === byType.get('transcript.final')?.properties.text.maxLength, 'final text bounds disagree');
check(chunkMax === byType.get('transcript.partial')?.properties.text.maxLength, 'chunk bounds disagree');
check(Number.isSafeInteger(turnMax) && Number.isSafeInteger(chunkMax), 'missing text bounds');

function kotlinType(prop) {
  if (prop.enum) return enumMap.get(JSON.stringify(prop.enum));
  return prop.type === 'integer' ? 'Long' : 'String';
}
function emitModel(lines, name, object, eventType) {
  const required = new Set(object.required);
  lines.push('@Serializable');
  if (eventType) lines.push(`@SerialName(${quote(eventType)})`);
  lines.push(`data class ${name}(`);
  for (const [field, prop] of Object.entries(object.properties)) {
    if (eventType && field === 'type') continue; // The sealed-class discriminator supplies it.
    const optional = !required.has(field);
    const override = eventType && (field === 'conversationId' || field === 'turnId') ? 'override ' : '';
    const annotation = prop.type === 'integer' ? '@Serializable(with = ConversationEpochMillisSerializer::class) ' : '';
    lines.push(`    ${annotation}@SerialName(${quote(field)}) ${override}val ${field}: ${kotlinType(prop)}${optional ? '? = null' : ''},`);
  }
  lines.push(eventType ? ') : ConversationEvent()' : ')');
  lines.push('');
}
function emitRules(lines, object, indent, prefix, trailingComma = false) {
  const required = new Set(object.required);
  lines.push(`${indent}${prefix}ConversationObjectRule(mapOf(`);
  for (const [field, prop] of Object.entries(object.properties)) {
    const args = [`required = ${required.has(field)}`, `kind = ConversationFieldKind.${prop.type === 'integer' ? 'INTEGER' : 'STRING'}`];
    for (const key of ['format', 'pattern', 'const']) {
      if (prop[key] !== undefined) args.push(`${key === 'const' ? 'literal' : key} = ${quote(prop[key])}`);
    }
    if (prop.enum) args.push(`values = setOf(${prop.enum.map(quote).join(', ')})`);
    for (const [schemaKey, kotlinKey] of [['minLength', 'minLength'], ['maxLength', 'maxLength'], ['minimum', 'minimum'], ['maximum', 'maximum']]) {
      if (prop[schemaKey] !== undefined) args.push(`${kotlinKey} = ${prop[schemaKey]}${prop.type === 'integer' ? 'L' : ''}`);
    }
    lines.push(`${indent}    ${quote(field)} to ConversationFieldRule(${args.join(', ')}),`);
  }
  lines.push(`${indent}))${trailingComma ? ',' : ''}`);
}

const lines = [
  '/**',
  ' * Generated from packages/protocol/schema/conversation-v1.schema.json.',
  ' * Do not edit; run pnpm --filter @vanessa/protocol build.',
  ' * Decode wire JSON using ConversationCodec, not a bare Json decoder:',
  ' * the generated rules enforce UUIDs, bounds and strict member types.',
  ' */',
  'package com.vanessa.protocol.conversation',
  '',
  'import kotlinx.serialization.SerialName',
  'import kotlinx.serialization.Serializable',
  '',
  `const val CONVERSATION_PROTOCOL_VERSION: Int = ${schema['x-vanessa-protocolVersion']}`,
  `const val MAX_CONVERSATION_TURNS: Int = ${schema['x-vanessa-maxConversationTurns']}`,
  `const val MAX_TURN_CONTENT: Int = ${turnMax}`,
  `const val MAX_TRANSCRIPT_CHUNK: Int = ${chunkMax}`,
  '',
];
for (const [name, definition] of enumDefinitions) {
  lines.push('@Serializable');
  lines.push(`enum class ${name} {`);
  for (const value of definition.enum) lines.push(`    @SerialName(${quote(value)}) ${enumConstant(value)},`);
  lines.push('}');
  lines.push('');
}
lines.push('@Serializable');
lines.push('sealed class ConversationEvent {');
lines.push('    abstract val conversationId: String');
lines.push('    abstract val turnId: String');
lines.push('}');
lines.push('');
for (const event of events) {
  const type = event.properties.type.const;
  emitModel(lines, className(type), event, type);
}
emitModel(lines, 'ConversationSession', definitions.ConversationSession);
emitModel(lines, 'ConversationTurn', definitions.ConversationTurn);
lines.push('/** Wire validation rules generated from the same schema as the models. */');
lines.push('internal object GeneratedConversationContract {');
lines.push('    val events: Map<String, ConversationObjectRule> = mapOf(');
for (const event of events) {
  emitRules(lines, event, '        ', `${quote(event.properties.type.const)} to `, true);
}
lines.push('    )');
emitRules(lines, definitions.ConversationSession, '    ', 'val session: ConversationObjectRule = ');
emitRules(lines, definitions.ConversationTurn, '    ', 'val turn: ConversationObjectRule = ');
lines.push('}');
lines.push('');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));
console.log(`Generated conversation Kotlin models and validation rules: ${out}`);
