package com.vanessa.mobile.model

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class GgufModelValidatorTest {
    private fun gguf(version: Int = 3) = byteArrayOf(
        'G'.code.toByte(), 'G'.code.toByte(), 'U'.code.toByte(), 'F'.code.toByte(),
        version.toByte(), 0, 0, 0, 1, 2, 3, 4,
    )

    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun rejects(reason: ModelValidationError, action: () -> Unit) {
        try {
            action()
            fail("Expected $reason")
        } catch (error: ModelValidationException) {
            assertEquals(reason, error.reason)
        }
    }

    @Test
    fun acceptsVersionsTwoAndThreeAndCopiesWithHash() {
        for (version in 2..3) {
            val data = gguf(version)
            val target = ByteArrayOutputStream()
            val verified = GgufModelValidator.verify(
                ByteArrayInputStream(data), target, declaredBytes = data.size.toLong(),
                availableBytes = { 100L * 1024 * 1024 }, expectedSha256 = sha(data).uppercase(),
            )
            assertArrayEquals(data, target.toByteArray())
            assertEquals(data.size.toLong(), verified.bytes)
            assertEquals(sha(data), verified.sha256)
        }
    }

    @Test
    fun rejectsTruncatedHeaderBadSignatureAndUnsupportedVersion() {
        rejects(ModelValidationError.TOO_SMALL) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf().copyOf(7)))
        }
        rejects(ModelValidationError.INVALID_HEADER) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf().also { it[0] = 0 }))
        }
        for (version in listOf(1, 4)) {
            rejects(ModelValidationError.UNSUPPORTED_VERSION) {
                GgufModelValidator.verify(ByteArrayInputStream(gguf(version)))
            }
        }
    }

    @Test
    fun rejectsWrongOrMalformedChecksum() {
        rejects(ModelValidationError.INVALID_CHECKSUM) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf()), expectedSha256 = "not a sha")
        }
        rejects(ModelValidationError.CHECKSUM_MISMATCH) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf()), expectedSha256 = "0".repeat(64))
        }
    }

    @Test
    fun enforcesDeclaredAndActualSizeAndAvailableSpace() {
        rejects(ModelValidationError.TOO_LARGE) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf()), maxBytes = 10)
        }
        rejects(ModelValidationError.TOO_LARGE) {
            GgufModelValidator.verify(ByteArrayInputStream(gguf()), declaredBytes = 100, maxBytes = 12)
        }
        rejects(ModelValidationError.INSUFFICIENT_STORAGE) {
            GgufModelValidator.verify(
                ByteArrayInputStream(gguf()), ByteArrayOutputStream(),
                availableBytes = { GgufModelValidator.STORAGE_RESERVE_BYTES + 4 },
            )
        }
    }

    @Test
    fun interruptionCancelsBeforeCopy() {
        Thread.currentThread().interrupt()
        try {
            try {
                GgufModelValidator.verify(ByteArrayInputStream(gguf()), ByteArrayOutputStream())
                fail("Expected cancellation")
            } catch (_: CancellationException) {
                // Interrupted flag is preserved for the caller.
            }
        } finally {
            Thread.interrupted()
        }
    }
}
