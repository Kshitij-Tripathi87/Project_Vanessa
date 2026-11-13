package com.vanessa.mobile.bridge

import org.json.JSONObject
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The phone half of the message signing contract, kept free of Android APIs so
 * it can be verified against the PC's implementation in a JVM test.
 *
 *   signature = hex(HMAC-SHA256(secret, canonicalJson(message - signature)))
 */
object MessageSigning {

    /**
     * Deterministic JSON matching TypeScript's `canonicalJson`: object keys are
     * sorted at every depth and no insignificant whitespace is emitted, so both
     * languages hash identical bytes regardless of property order.
     */
    fun canonicalJson(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is String -> JSONObject.quote(value)
        is Number -> value.toString()
        is Map<*, *> -> value.entries
            .map { (key, entryValue) -> JSONObject.quote(key.toString()) to canonicalJson(entryValue) }
            .sortedBy { it.first }
            .joinToString(",", "{", "}") { (key, rendered) -> "$key:$rendered" }
        is Iterable<*> -> value.joinToString(",", "[", "]") { canonicalJson(it) }
        is Array<*> -> value.joinToString(",", "[", "]") { canonicalJson(it) }
        else -> JSONObject.quote(value.toString())
    }

    /**
     * Return a copy of [message] carrying a nonce and a signature computed over
     * the message without the signature field.
     */
    fun sign(
        message: Map<String, Any>,
        secret: String,
        nonce: String = UUID.randomUUID().toString(),
    ): Map<String, Any> {
        val signed = LinkedHashMap<String, Any>(message)
        signed["nonce"] = nonce

        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val signature = mac.doFinal(canonicalJson(signed).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

        signed["signature"] = signature
        return signed
    }

    /** Constant-time check used by tests and diagnostics. */
    fun matches(expected: String, supplied: String): Boolean {
        if (expected.length != supplied.length) return false
        var difference = 0
        for (index in expected.indices) {
            difference = difference or (expected[index].code xor supplied[index].code)
        }
        return difference == 0
    }
}
