package com.vanessa.protocol.v2

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/** Reject duplicate JSON member names before signature parsing/canonicalization. */
internal object JsonDuplicateMemberGuard {
    private const val MAX_DEPTH = 64
    private val json = Json

    fun requireUniqueMembers(source: String) {
        Scanner(source).scanDocument()
    }

    private class Scanner(private val source: String) {
        private var offset = 0

        fun scanDocument() {
            skipWhitespace()
            scanValue(0)
            skipWhitespace()
            require(offset == source.length) { "Envelope contains trailing JSON data" }
        }

        private fun scanValue(depth: Int) {
            skipWhitespace()
            require(depth <= MAX_DEPTH) { "Envelope JSON is nested too deeply" }
            when (source.getOrNull(offset)) {
                '"' -> readString()
                '{' -> scanObject(depth)
                '[' -> scanArray(depth)
                else -> scanScalar()
            }
        }

        private fun scanObject(depth: Int) {
            offset++
            skipWhitespace()
            if (source.getOrNull(offset) == '}') {
                offset++
                return
            }
            val keys = HashSet<String>()
            while (true) {
                skipWhitespace()
                require(source.getOrNull(offset) == '"') { "Envelope object key must be a string" }
                val keyStart = offset
                readString()
                val key = json.decodeFromString<String>(source.substring(keyStart, offset))
                require(keys.add(key)) { "Envelope contains a duplicate JSON object member" }
                skipWhitespace()
                require(source.getOrNull(offset) == ':') { "Envelope object member is missing a colon" }
                offset++
                scanValue(depth + 1)
                skipWhitespace()
                when (source.getOrNull(offset)) {
                    ',' -> offset++
                    '}' -> {
                        offset++
                        return
                    }
                    else -> throw IllegalArgumentException("Envelope object is malformed")
                }
            }
        }

        private fun scanArray(depth: Int) {
            offset++
            skipWhitespace()
            if (source.getOrNull(offset) == ']') {
                offset++
                return
            }
            while (true) {
                scanValue(depth + 1)
                skipWhitespace()
                when (source.getOrNull(offset)) {
                    ',' -> offset++
                    ']' -> {
                        offset++
                        return
                    }
                    else -> throw IllegalArgumentException("Envelope array is malformed")
                }
            }
        }

        private fun readString() {
            require(source.getOrNull(offset) == '"') { "Expected JSON string" }
            offset++
            while (offset < source.length) {
                val char = source[offset++]
                when {
                    char == '"' -> return
                    char == '\\' -> {
                        require(offset < source.length) { "Incomplete JSON string escape" }
                        val escaped = source[offset++]
                        if (escaped == 'u') {
                            require(offset + 4 <= source.length) { "Incomplete JSON unicode escape" }
                            offset += 4
                        }
                    }
                    char.code < 0x20 -> throw IllegalArgumentException("JSON string contains a control character")
                }
            }
            throw IllegalArgumentException("Unterminated JSON string")
        }

        private fun scanScalar() {
            val start = offset
            while (offset < source.length) {
                val char = source[offset]
                if (char == ',' || char == '}' || char == ']' ||
                    char == ' ' || char == '\t' || char == '\n' || char == '\r'
                ) break
                offset++
            }
            require(offset > start) { "Invalid JSON value" }
        }

        private fun skipWhitespace() {
            while (offset < source.length &&
                (source[offset] == ' ' || source[offset] == '\t' ||
                    source[offset] == '\n' || source[offset] == '\r')
            ) offset++
        }
    }
}
