package com.vanessa.mobile.model

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.CancellationException

/** Validates the GGUF signature and supported format version, not tensor integrity or runtime compatibility. */
object GgufModelValidator {
    const val DEFAULT_MAX_BYTES: Long = 8L * 1024 * 1024 * 1024
    const val STORAGE_RESERVE_BYTES: Long = 16L * 1024 * 1024
    private const val HEADER_BYTES = 8

    fun normalizeSha256(expected: String): String {
        if (expected.length != 64 || !expected.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            throw ModelValidationException(ModelValidationError.INVALID_CHECKSUM)
        }
        return expected.lowercase(java.util.Locale.ROOT)
    }

    /** Set output to null to validate an already-installed file without copying it. */
    fun verify(
        input: InputStream,
        output: OutputStream? = null,
        maxBytes: Long = DEFAULT_MAX_BYTES,
        declaredBytes: Long? = null,
        availableBytes: (() -> Long)? = null,
        expectedSha256: String? = null,
    ): VerifiedModel {
        require(maxBytes >= HEADER_BYTES)
        val expected = expectedSha256?.let(::normalizeSha256)
        if (declaredBytes != null) {
            if (declaredBytes < HEADER_BYTES) throw ModelValidationException(ModelValidationError.TOO_SMALL)
            if (declaredBytes > maxBytes) throw ModelValidationException(ModelValidationError.TOO_LARGE)
            if (output != null && availableBytes != null &&
                availableBytes() - STORAGE_RESERVE_BYTES < declaredBytes
            ) throw ModelValidationException(ModelValidationError.INSUFFICIENT_STORAGE)
        }

        val header = ByteArray(HEADER_BYTES)
        var headerRead = 0
        while (headerRead < HEADER_BYTES) {
            checkCancelled()
            val count = input.read(header, headerRead, HEADER_BYTES - headerRead)
            if (count < 0) throw ModelValidationException(ModelValidationError.TOO_SMALL)
            if (count > 0) headerRead += count
        }
        if (header[0] != 'G'.code.toByte() || header[1] != 'G'.code.toByte() ||
            header[2] != 'U'.code.toByte() || header[3] != 'F'.code.toByte()
        ) throw ModelValidationException(ModelValidationError.INVALID_HEADER)
        val version = (header[4].toInt() and 0xff) or
                ((header[5].toInt() and 0xff) shl 8) or
                ((header[6].toInt() and 0xff) shl 16) or
                ((header[7].toInt() and 0xff) shl 24)
        if (version != 2 && version != 3) throw ModelValidationException(ModelValidationError.UNSUPPORTED_VERSION)

        val digest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        fun consume(buffer: ByteArray, count: Int) {
            if (count.toLong() > maxBytes - bytes) throw ModelValidationException(ModelValidationError.TOO_LARGE)
            if (output != null && availableBytes != null &&
                availableBytes() - STORAGE_RESERVE_BYTES < count
            ) throw ModelValidationException(ModelValidationError.INSUFFICIENT_STORAGE)
            digest.update(buffer, 0, count)
            output?.write(buffer, 0, count)
            bytes += count
        }
        consume(header, HEADER_BYTES)
        val buffer = ByteArray(64 * 1024)
        while (true) {
            checkCancelled()
            val count = input.read(buffer)
            if (count < 0) break
            if (count > 0) consume(buffer, count)
        }
        checkCancelled()
        val sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (expected != null && expected != sha256) {
            throw ModelValidationException(ModelValidationError.CHECKSUM_MISMATCH)
        }
        return VerifiedModel(sha256, bytes)
    }

    private fun checkCancelled() {
        if (Thread.currentThread().isInterrupted) throw CancellationException("Model import interrupted")
    }
}

data class VerifiedModel(val sha256: String, val bytes: Long)

enum class ModelValidationError {
    INVALID_HEADER, UNSUPPORTED_VERSION, TOO_SMALL, TOO_LARGE, INSUFFICIENT_STORAGE,
    INVALID_CHECKSUM, CHECKSUM_MISMATCH,
}

class ModelValidationException(val reason: ModelValidationError) : Exception(reason.name)
