package com.vanessa.mobile.voice

/**
 * A permission dialog is not permission to start a later, abandoned recording.
 * At most one platform request may be outstanding; cancelling invalidates its
 * result without allowing an older callback to authorize a newer request.
 * Used on the Activity main thread.
 */
internal class MicrophonePermissionGate {
    private var pending = false
    private var interested = false

    val isPending: Boolean get() = pending

    fun begin(): Boolean {
        if (pending) return false
        pending = true
        interested = true
        return true
    }

    /** Keep the outstanding slot reserved until Android delivers its result. */
    fun cancel() {
        interested = false
    }

    /** Consume exactly one result. An invalidated or denied request cannot start capture. */
    fun resolve(granted: Boolean): Boolean {
        val mayStart = pending && interested && granted
        pending = false
        interested = false
        return mayStart
    }
}
