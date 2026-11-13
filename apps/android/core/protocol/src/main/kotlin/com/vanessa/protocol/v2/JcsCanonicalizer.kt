package com.vanessa.protocol.v2

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal

/**
 * RFC 8785 JSON Canonicalization Scheme for the bounded protocol payloads.
 *
 * Object names are sorted by UTF-16 code units (String.compareTo), arrays keep
 * their order, and numbers follow ECMAScript's finite IEEE-754 serialization
 * thresholds. All signed envelopes must pass through this implementation.
 */
object JcsCanonicalizer {
    private val fixedLowerBound = BigDecimal("0.000001")
    private val fixedUpperBound = BigDecimal("1E+21")

    fun canonicalize(value: JsonElement): String = when (value) {
        is JsonNull -> "null"
        is JsonPrimitive -> canonicalPrimitive(value)
        is JsonArray -> value.joinToString(separator = ",", prefix = "[", postfix = "]") {
            canonicalize(it)
        }
        is JsonObject -> value.entries
            .sortedBy { it.key }
            .joinToString(separator = ",", prefix = "{", postfix = "}") { (key, child) ->
                "${quote(key)}:${canonicalize(child)}"
            }
    }

    private fun canonicalPrimitive(value: JsonPrimitive): String {
        if (value.isString) return quote(value.content)
        return when (value.content) {
            "true", "false" -> value.content
            else -> canonicalNumber(value.content)
        }
    }

    /** JCS uses only mandatory JSON escapes and preserves valid UTF-16 pairs. */
    private fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        var index = 0
        while (index < value.length) {
            val char = value[index]
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\t' -> append("\\t")
                '\n' -> append("\\n")
                '\u000c' -> append("\\f")
                '\r' -> append("\\r")
                else -> when {
                    char.code < 0x20 -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
                    char.isHighSurrogate() && index + 1 < value.length && value[index + 1].isLowSurrogate() -> {
                        append(char)
                        append(value[index + 1])
                        index++
                    }
                    char.isSurrogate() -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
                    else -> append(char)
                }
            }
            index++
        }
        append('"')
    }

    private fun canonicalNumber(raw: String): String {
        val number = raw.toDoubleOrNull()
            ?: throw IllegalArgumentException("Invalid JSON number in canonical input")
        require(number.isFinite()) { "JCS does not allow non-finite numbers" }
        if (number == 0.0) return "0" // Includes negative zero.

        val decimal = BigDecimal(java.lang.Double.toString(number)).stripTrailingZeros()
        val absolute = decimal.abs()
        if (absolute >= fixedLowerBound && absolute < fixedUpperBound) {
            return decimal.toPlainString()
        }

        val digits = decimal.unscaledValue().abs().toString()
        val exponent = digits.length - decimal.scale() - 1
        val fraction = if (digits.length > 1) {
            "." + digits.substring(1).trimEnd('0')
        } else {
            ""
        }
        val sign = if (decimal.signum() < 0) "-" else ""
        val exponentText = if (exponent >= 0) "+$exponent" else exponent.toString()
        return "$sign${digits[0]}$fraction" + "e" + exponentText
    }
}
