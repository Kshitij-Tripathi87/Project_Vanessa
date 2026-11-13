#include <jni.h>
#include <llama.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::mutex runtime_mutex;
std::atomic<bool> cancelled{false};
llama_model * model = nullptr;
llama_context * context = nullptr;
bool backend_initialized = false;

using Clock = std::chrono::steady_clock;

void check_cancelled() {
    if (cancelled.load(std::memory_order_relaxed)) {
        throw std::runtime_error("Inference cancelled");
    }
}

bool abort_decode(void *) { return cancelled.load(std::memory_order_relaxed); }
bool load_progress(float, void *) { return !cancelled.load(std::memory_order_relaxed); }

void release() {
    if (context) { llama_free(context); context = nullptr; }
    if (model) { llama_model_free(model); model = nullptr; }
}

void fail(JNIEnv * env, const std::string & message) {
    jclass type = env->FindClass("java/lang/IllegalStateException");
    if (type) env->ThrowNew(type, message.c_str());
}

std::string from_bytes(JNIEnv * env, jbyteArray bytes) {
    const auto length = env->GetArrayLength(bytes);
    std::string result(static_cast<size_t>(length), '\0');
    if (length) env->GetByteArrayRegion(bytes, 0, length, reinterpret_cast<jbyte *>(&result[0]));
    return result;
}

struct Result {
    std::string text;
    int prompt_tokens;
    int generated_tokens;
    int64_t ttft_ms;
    double tokens_per_second;
};

Result generate(const std::string & prompt, int max_tokens, const std::string & grammar) {
    if (!model || !context) throw std::runtime_error("Load a GGUF before generating");
    if (prompt.empty() || prompt.size() > 1024 * 1024) throw std::runtime_error("Prompt is empty or too large");
    if (max_tokens < 1 || max_tokens > 2048) throw std::runtime_error("Invalid maxTokens");
    const llama_vocab * vocab = llama_model_get_vocab(model);
    const int32_t capacity = static_cast<int32_t>(llama_n_ctx(context));
    std::vector<llama_token> tokens(static_cast<size_t>(capacity));
    const int32_t count = llama_tokenize(vocab, prompt.data(), static_cast<int32_t>(prompt.size()),
                                          tokens.data(), capacity, false, true);
    if (count <= 0 || count >= capacity) throw std::runtime_error("Prompt exceeds the model context window");
    tokens.resize(static_cast<size_t>(count));
    llama_memory_clear(llama_get_memory(context), false);

    const auto start = Clock::now();
    for (int32_t offset = 0; offset < count;) {
        check_cancelled();
        const int32_t size = std::min<int32_t>(256, count - offset);
        if (llama_decode(context, llama_batch_get_one(tokens.data() + offset, size)) != 0) {
            check_cancelled();
            throw std::runtime_error("llama_decode failed during prompt evaluation");
        }
        offset += size;
    }

    llama_sampler * sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (!sampler) throw std::runtime_error("Could not create llama sampler");
    try {
        if (!grammar.empty()) {
            llama_sampler * grammar_sampler = llama_sampler_init_grammar(vocab, grammar.c_str(), "root");
            if (!grammar_sampler) throw std::runtime_error("Could not initialise the constrained-decoding grammar");
            llama_sampler_chain_add(sampler, grammar_sampler);
        }
        // Qwen3's recommended non-thinking sampling profile: temperature 0.7,
        // top-p 0.8 and top-k 20. Grammar filtering runs before token selection.
        llama_sampler_chain_add(sampler, llama_sampler_init_top_k(20));
        llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.8f, 1));
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.7f));
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(std::random_device{}()));
        std::string text;
        int generated = 0;
        int64_t ttft_ms = 0;
        Clock::time_point first_token;
        Clock::time_point last_token;
        for (int i = 0; i < max_tokens && count + generated < capacity; ++i) {
            check_cancelled();
            const llama_token token = llama_sampler_sample(sampler, context, -1);
            if (token == LLAMA_TOKEN_NULL) throw std::runtime_error("Sampling failed");
            if (llama_vocab_is_eog(vocab, token)) break;
            if (generated == 0) {
                first_token = Clock::now();
                ttft_ms = std::chrono::duration_cast<std::chrono::milliseconds>(first_token - start).count();
            }
            last_token = Clock::now();
            ++generated;
            int32_t length = llama_token_to_piece(vocab, token, nullptr, 0, 0, false);
            if (length < 0) {
                std::string piece(static_cast<size_t>(-length), '\0');
                length = llama_token_to_piece(vocab, token, &piece[0], -length, 0, false);
                if (length < 0) throw std::runtime_error("Token decoding failed");
                text.append(piece.data(), static_cast<size_t>(length));
            } else if (length > 0) {
                std::string piece(static_cast<size_t>(length), '\0');
                length = llama_token_to_piece(vocab, token, &piece[0], length, 0, false);
                if (length < 0) throw std::runtime_error("Token decoding failed");
                text.append(piece.data(), static_cast<size_t>(length));
            }
            if (i + 1 < max_tokens && count + generated < capacity) {
                llama_token next = token;
                if (llama_decode(context, llama_batch_get_one(&next, 1)) != 0) {
                    check_cancelled();
                    throw std::runtime_error("llama_decode failed during generation");
                }
            }
        }
        check_cancelled();
        const double seconds = generated > 0
            ? std::chrono::duration<double>(last_token - start).count() - static_cast<double>(ttft_ms) / 1000.0
            : 0.0;
        Result result{text, count, generated, ttft_ms, seconds > 0 ? generated / seconds : 0.0};
        llama_sampler_free(sampler);
        return result;
    } catch (...) {
        llama_sampler_free(sampler);
        throw;
    }
}
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_vanessa_mobile_inference_LlamaCppInference_nativeLoad(JNIEnv * env, jobject, jstring path) {
    std::lock_guard<std::mutex> guard(runtime_mutex);
    try {
        if (!path) throw std::runtime_error("Model path is missing");
        const char * chars = env->GetStringUTFChars(path, nullptr);
        if (!chars) return;
        std::string file(chars);
        env->ReleaseStringUTFChars(path, chars);
        cancelled.store(false);
        release();
        if (!backend_initialized) { llama_backend_init(); backend_initialized = true; }
        auto params = llama_model_default_params();
        params.n_gpu_layers = 0;
        params.progress_callback = load_progress;
        model = llama_model_load_from_file(file.c_str(), params);
        check_cancelled();
        if (!model) throw std::runtime_error("Could not load GGUF model");
        if (!llama_model_has_decoder(model)) throw std::runtime_error("GGUF is not a text generation model");
        auto options = llama_context_default_params();
        options.n_ctx = 2048;
        options.n_batch = 256;
        options.n_ubatch = 256;
        options.abort_callback = abort_decode;
        context = llama_init_from_model(model, options);
        check_cancelled();
        if (!context) throw std::runtime_error("Could not create llama context");
    } catch (const std::exception & error) {
        release();
        fail(env, error.what());
    }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_vanessa_mobile_inference_LlamaCppInference_nativeGenerate(JNIEnv * env, jobject,
                                                                      jbyteArray prompt, jint max_tokens,
                                                                      jstring grammar) {
    try {
        if (!prompt) throw std::runtime_error("Prompt is missing");
        const std::string input = from_bytes(env, prompt);
        if (env->ExceptionCheck()) return nullptr;
        std::string grammar_text;
        if (grammar) {
            const char * chars = env->GetStringUTFChars(grammar, nullptr);
            if (!chars) return nullptr;
            grammar_text.assign(chars);
            env->ReleaseStringUTFChars(grammar, chars);
        }
        std::lock_guard<std::mutex> guard(runtime_mutex);
        cancelled.store(false);
        const Result result = generate(input, max_tokens, grammar_text);
        if (result.text.size() > static_cast<size_t>(std::numeric_limits<jsize>::max()))
            throw std::runtime_error("Output too large");
        jbyteArray bytes = env->NewByteArray(static_cast<jsize>(result.text.size()));
        if (!bytes) return nullptr;
        if (!result.text.empty()) env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(result.text.size()),
                                                reinterpret_cast<const jbyte *>(result.text.data()));
        jclass type = env->FindClass("com/vanessa/mobile/inference/LlamaCppInference$NativeGeneration");
        if (!type || env->ExceptionCheck()) return nullptr;
        jmethodID ctor = env->GetMethodID(type, "<init>", "([BIIJD)V");
        if (!ctor) return nullptr;
        return env->NewObject(type, ctor, bytes, result.prompt_tokens, result.generated_tokens,
                              static_cast<jlong>(result.ttft_ms), result.tokens_per_second);
    } catch (const std::exception & error) {
        fail(env, error.what());
        return nullptr;
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_vanessa_mobile_inference_LlamaCppInference_nativeCancel(JNIEnv *, jobject) {
    cancelled.store(true);
}

extern "C" JNIEXPORT void JNICALL
Java_com_vanessa_mobile_inference_LlamaCppInference_nativeClose(JNIEnv *, jobject) {
    cancelled.store(true);
    std::lock_guard<std::mutex> guard(runtime_mutex);
    release();
}
