#!/usr/bin/env node
/** Generate the conversation wire schema from the canonical Zod declarations.
 * This is independent of the legacy phone/PC v1 schema and generator.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CONVERSATION_PROTOCOL_VERSION,
  MAX_CONVERSATION_TURNS,
  ConversationEventSchema,
  ConversationSessionSchema,
  ConversationTurnSchema,
  ConversationStatusSchema,
  ConversationTurnRoleSchema,
  ConversationTurnSourceSchema,
  ConversationTurnStatusSchema,
  InterruptReasonSchema,
} from '../dist/conversation.js';

const dir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(dir, '..', 'schema', `conversation-v${CONVERSATION_PROTOCOL_VERSION}.schema.json`);

// Flatten repeated Zod nodes instead of making the Kotlin generator infer
// context-dependent $refs. Each definition is still derived from Zod itself.
function definition(name, zodSchema) {
  const converted = zodToJsonSchema(zodSchema, { name, $refStrategy: 'none' });
  const result = converted.definitions?.[name];
  if (!result) throw new Error(`No generated schema definition for ${name}`);
  return result;
}

const definitions = {
  ConversationEvent: definition('ConversationEvent', ConversationEventSchema),
  ConversationSession: definition('ConversationSession', ConversationSessionSchema),
  ConversationTurn: definition('ConversationTurn', ConversationTurnSchema),
  ConversationStatus: definition('ConversationStatus', ConversationStatusSchema),
  ConversationTurnRole: definition('ConversationTurnRole', ConversationTurnRoleSchema),
  ConversationTurnSource: definition('ConversationTurnSource', ConversationTurnSourceSchema),
  ConversationTurnStatus: definition('ConversationTurnStatus', ConversationTurnStatusSchema),
  InterruptReason: definition('InterruptReason', InterruptReasonSchema),
};

// JSON Schema's standard minLength/maxLength count Unicode code points. Zod's
// string bounds, and Kotlin String.length, count UTF-16 code units instead. Keep
// the standard constraints for ordinary validators, but annotate every bounded
// string with the exact additional constraint our strict wire codecs enforce.
// A generic JSON Schema validator alone is insufficient for astral characters.
function annotateUtf16Bounds(value) {
  if (Array.isArray(value)) return value.forEach(annotateUtf16Bounds);
  if (!value || typeof value !== 'object') return;
  if (value.type === 'string') {
    if (value.minLength !== undefined) value['x-vanessa-minUtf16Length'] = value.minLength;
    if (value.maxLength !== undefined) value['x-vanessa-maxUtf16Length'] = value.maxLength;
  }
  Object.values(value).forEach(annotateUtf16Bounds);
}
annotateUtf16Bounds(definitions);

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $comment: 'Generated from conversation.ts. String limits use UTF-16 code units; enforce x-vanessa-minUtf16Length and x-vanessa-maxUtf16Length in addition to standard JSON Schema keywords.',
  'x-vanessa-protocolVersion': CONVERSATION_PROTOCOL_VERSION,
  'x-vanessa-maxConversationTurns': MAX_CONVERSATION_TURNS,
  $ref: '#/definitions/ConversationEvent',
  definitions,
};
mkdirSync(dirname(schemaPath), { recursive: true });
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Generated conversation JSON Schema: ${schemaPath}`);
