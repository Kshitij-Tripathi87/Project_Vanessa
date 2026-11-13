package com.vanessa.mobile.inference

import ai.vanessa.agent.LocalInference
import android.content.Context
import android.os.Build
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** Single-process, offline llama.cpp adapter. Call loadModel before generate. */
class LlamaCppInference private constructor(private val context: Context) : LocalInference, AutoCloseable {
    data class GenerationResult(
        val text: String,
        val promptTokens: Int,
        val generatedTokens: Int,
        val ttftMs: Long,
        val tokensPerSecond: Double,
    )

    private data class NativeGeneration(
        val bytes: ByteArray,
        val promptTokens: Int,
        val generatedTokens: Int,
        val ttftMs: Long,
        val tokensPerSecond: Double,
    )

    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "vanessa-llama").apply { isDaemon = true }
    }
    private val closed = AtomicBoolean(false)

    @Volatile
    var lastGenerationMetrics: GenerationResult? = null
        private set

    @Volatile
    var isModelLoaded: Boolean = false
        private set

    /** True only if the native library can actually be loaded on this device. */
    val isAvailable: Boolean by lazy {
        Build.VERSION.SDK_INT >= 28 && Build.SUPPORTED_ABIS.contains("arm64-v8a") &&
                try {
                    System.loadLibrary("vanessa_llama")
                    true
                } catch (_: UnsatisfiedLinkError) {
                    false
                }
    }

    /** The GGUF must be a regular file beneath Context.filesDir (e.g. filesDir/models/model.gguf). */
    suspend fun loadModel(gguf: File) {
        check(isAvailable) { "Local llama.cpp runtime requires arm64-v8a, API 28+, and a native build" }
        val root = context.filesDir.canonicalFile
        val model = gguf.canonicalFile
        require(model.isFile && model.toPath().startsWith(root.toPath()) && model != root) {
            "GGUF must exist in app-private filesDir"
        }
        isModelLoaded = false
        execute { nativeLoad(model.path) }
        isModelLoaded = true
    }

    /** Runs on a worker thread; cancellation interrupts loading/prefill/decoding via native callbacks. */
    suspend fun generateResult(
        prompt: String,
        maxTokens: Int = 256,
        grammar: String? = null,
    ): GenerationResult {
        check(isAvailable) { "Local llama.cpp runtime is unavailable" }
        require(maxTokens in 1..2048) { "maxTokens must be between 1 and 2048" }
        val formattedPrompt = Qwen3PromptTemplate.format(prompt)
        val result = execute {
            nativeGenerate(formattedPrompt.toByteArray(Charsets.UTF_8), maxTokens, grammar)
        }
        return GenerationResult(
            result.bytes.toString(Charsets.UTF_8), result.promptTokens,
            result.generatedTokens, result.ttftMs, result.tokensPerSecond,
        ).also { lastGenerationMetrics = it }
    }

    override suspend fun generate(prompt: String): String = generateResult(prompt).text

    override suspend fun generateConstrained(prompt: String, grammar: String): String {
        require(grammar.isNotBlank() && grammar.length <= 16_384) { "Invalid decoding grammar" }
        return generateResult(prompt, maxTokens = 160, grammar = grammar).text
    }

    private suspend fun <T> execute(block: () -> T): T = suspendCancellableCoroutine { continuation ->
        if (closed.get()) {
            continuation.resumeWithException(IllegalStateException("Inference adapter is closed"))
            return@suspendCancellableCoroutine
        }
        continuation.invokeOnCancellation { nativeCancel() }
        try {
            worker.execute work@{
                if (!continuation.isActive) return@work
                try {
                    val result = block()
                    if (continuation.isActive) continuation.resume(result)
                } catch (error: Throwable) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }
    }

    /** Cancels pending work and waits for native resources to be freed. Do not call on the UI thread. */
    override fun close() {
        if (closed.compareAndSet(false, true)) {
            if (isAvailable) {
                nativeCancel()
                nativeClose()
            }
            isModelLoaded = false
            worker.shutdownNow()
            synchronized(LlamaCppInference) { instance = null }
        }
    }

    private external fun nativeLoad(path: String)
    private external fun nativeGenerate(prompt: ByteArray, maxTokens: Int, grammar: String?): NativeGeneration
    private external fun nativeCancel()
    private external fun nativeClose()

    companion object {
        private var instance: LlamaCppInference? = null

        @Synchronized
        fun getInstance(context: Context): LlamaCppInference =
            instance ?: LlamaCppInference(context.applicationContext).also { instance = it }
    }
}
