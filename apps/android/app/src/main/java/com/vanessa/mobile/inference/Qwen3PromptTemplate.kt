package com.vanessa.mobile.inference

/**
 * Qwen3 instruct chat format. User text is escaped so it cannot inject control
 * tokens into the template. /no_think keeps the small local task planner focused
 * on bounded tool plans instead of spending latency on long reasoning traces.
 */
object Qwen3PromptTemplate {
    fun format(userPrompt: String): String {
        require(userPrompt.isNotBlank()) { "Prompt must not be blank" }
        require(userPrompt.length <= 8192) { "Prompt exceeds the local inference limit" }
        val safeUserText = userPrompt.replace("<|", "< |")
        return "<|im_start|>system\n" +
            "You are Vanessa, a concise on-device assistant. Follow the user's request. " +
            "When asked for a task plan, obey the exact output constraint. Never claim a tool ran unless evidence is supplied. " +
            "<|im_end|>\n" +
            "<|im_start|>user\n" + safeUserText + "\n/no_think<|im_end|>\n" +
            "<|im_start|>assistant\n"
    }
}
