package com.vanessa.mobile.model

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.OperationCanceledException
import android.provider.OpenableColumns
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.CancellationException

/** Call from a background thread after the UI obtains a content URI via ACTION_OPEN_DOCUMENT. */
class ModelManager(
    private val context: Context,
    private val maxModelBytes: Long = GgufModelValidator.DEFAULT_MAX_BYTES,
) {
    private val modelDir: File get() = File(context.filesDir, "models")
    private val modelFile: File get() = File(modelDir, "installed.gguf")

    /** The installed file is rehashed and its GGUF header checked before it is returned. */
    @Synchronized
    fun installedModel(): InstalledModel? {
        val file = modelFile
        if (!file.isFile || file.length() < 8 || file.length() > maxModelBytes) return null
        return try {
            val verified = FileInputStream(file).use { input ->
                GgufModelValidator.verify(input, maxBytes = maxModelBytes, declaredBytes = file.length())
            }
            InstalledModel(file.absolutePath, verified.sha256, verified.bytes)
        } catch (_: IOException) {
            null
        } catch (_: ModelValidationException) {
            null
        }
    }

    /** Streams to a temporary file in the destination directory; the previous model survives failures. */
    @Synchronized
    fun importModel(uri: Uri, expectedSha256: String? = null): ModelImportResult {
        var temporary: File? = null
        return try {
            if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
                return ModelImportResult.Failure("Select a content URI using the document picker")
            }
            val expected = expectedSha256?.let(GgufModelValidator::normalizeSha256)
            if (expected != null) {
                installedModel()?.takeIf { it.sha256 == expected }?.let {
                    return ModelImportResult.Success(it, alreadyInstalled = true)
                }
            }
            val directory = modelDir
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Cannot create model directory")
            val declaredBytes = context.contentResolver.query(
                uri, arrayOf(OpenableColumns.SIZE), null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val column = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (column >= 0 && !cursor.isNull(column)) cursor.getLong(column).takeIf { it >= 0 } else null
                } else null
            }
            // Reject known oversized files before opening a stream or allocating a temp file.
            if (declaredBytes != null && declaredBytes > maxModelBytes) {
                throw ModelValidationException(ModelValidationError.TOO_LARGE)
            }
            if (declaredBytes != null && declaredBytes < 8) {
                throw ModelValidationException(ModelValidationError.TOO_SMALL)
            }
            if (declaredBytes != null && directory.usableSpace - GgufModelValidator.STORAGE_RESERVE_BYTES < declaredBytes) {
                throw ModelValidationException(ModelValidationError.INSUFFICIENT_STORAGE)
            }
            val input = context.contentResolver.openInputStream(uri) ?: throw IOException("Document cannot be opened")
            input.use { source ->
                temporary = File.createTempFile("incoming-", ".gguf", directory)
                val target = temporary!!
                val verified = FileOutputStream(target).use { sink ->
                    GgufModelValidator.verify(
                        source, sink, maxBytes = maxModelBytes, declaredBytes = declaredBytes,
                        availableBytes = { directory.usableSpace }, expectedSha256 = expected,
                    ).also { sink.fd.sync() }
                }
                val current = installedModel()
                if (current != null && current.sha256 == verified.sha256) {
                    return ModelImportResult.Success(current, alreadyInstalled = true)
                }
                // Both files reside in the same private directory. Do not fall back to a non-atomic move.
                Files.move(
                    target.toPath(), modelFile.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING
                )
                ModelImportResult.Success(
                    InstalledModel(modelFile.absolutePath, verified.sha256, verified.bytes),
                    alreadyInstalled = false,
                )
            }
        } catch (_: OperationCanceledException) {
            ModelImportResult.Cancelled
        } catch (_: CancellationException) {
            ModelImportResult.Cancelled
        } catch (_: InterruptedIOException) {
            ModelImportResult.Cancelled
        } catch (error: ModelValidationException) {
            ModelImportResult.Failure(error.reason.name)
        } catch (error: IOException) {
            if (Thread.currentThread().isInterrupted) ModelImportResult.Cancelled
            else ModelImportResult.Failure(error.message ?: "Model import I/O failed")
        } catch (error: SecurityException) {
            ModelImportResult.Failure(error.message ?: "Document access denied")
        } finally {
            temporary?.delete()
        }
    }
}

data class InstalledModel(val path: String, val sha256: String, val bytes: Long)

sealed interface ModelImportResult {
    data class Success(val model: InstalledModel, val alreadyInstalled: Boolean) : ModelImportResult
    data class Failure(val reason: String) : ModelImportResult
    data object Cancelled : ModelImportResult
}
