/**
 * Auto-generated from protocol-v1.schema.json.
 * DO NOT EDIT BY HAND — regenerate with
 *   pnpm --filter @vanessa/protocol build
 */
package com.vanessa.mobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Protocol version. Must match packages/protocol/src/protocol.ts. */
const val PROTOCOL_VERSION: Int = 1

/**
 * Discriminated union over all message types the phone <-> PC link carries.
 * The `type` field is the discriminator; the PC validates inbound messages
 * against the same schema, so the two sides cannot drift.
 */
@Serializable
sealed class VanessaProtocolMessage {
    abstract val v: Int
    abstract val id: String
    abstract val timestamp: Long
    abstract val type: String

    companion object {
        const val VERSION: Int = PROTOCOL_VERSION
    }
}

/**
 * task.submit message.
 */
@Serializable
@SerialName("task.submit")
data class TaskSubmit(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("idempotencyKey") val idempotencyKey: String,
    @SerialName("tool") val tool: String,
    @SerialName("args") val args: JsonObject,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val type: String = "task.submit"
}

/**
 * task.accepted message.
 */
@Serializable
@SerialName("task.accepted")
data class TaskAccepted(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String
) : VanessaProtocolMessage() {
    override val type: String = "task.accepted"
}

/**
 * task.progress message.
 */
@Serializable
@SerialName("task.progress")
data class TaskProgress(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String,
    @SerialName("state") val state: String,
    @SerialName("message") val message: String? = null,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val type: String = "task.progress"
}

/**
 * task.confirm_required message.
 */
@Serializable
@SerialName("task.confirm_required")
data class TaskConfirm_required(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String,
    @SerialName("summary") val summary: String,
    @SerialName("actionHash") val actionHash: String,
    @SerialName("expiresAt") val expiresAt: Long
) : VanessaProtocolMessage() {
    override val type: String = "task.confirm_required"
}

/**
 * task.confirm message.
 */
@Serializable
@SerialName("task.confirm")
data class TaskConfirm(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String,
    @SerialName("approved") val approved: Boolean,
    @SerialName("actionHash") val actionHash: String,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val type: String = "task.confirm"
}

/**
 * task.result message.
 */
@Serializable
@SerialName("task.result")
data class TaskResult(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String,
    @SerialName("status") val status: String,
    @SerialName("result") val result: JsonElement? = null
) : VanessaProtocolMessage() {
    override val type: String = "task.result"
}

/**
 * task.error message.
 */
@Serializable
@SerialName("task.error")
data class TaskError(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String? = null,
    @SerialName("code") val code: String,
    @SerialName("message") val message: String
) : VanessaProtocolMessage() {
    override val type: String = "task.error"
}

/**
 * task.cancel message.
 */
@Serializable
@SerialName("task.cancel")
data class TaskCancel(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("taskId") val taskId: String,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val type: String = "task.cancel"
}

/**
 * manifest.sync message.
 */
@Serializable
@SerialName("manifest.sync")
data class ManifestSync(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("manifestVersion") val manifestVersion: String,
    @SerialName("tools") val tools: JsonArray
) : VanessaProtocolMessage() {
    override val type: String = "manifest.sync"
}

/**
 * event.push message.
 */
@Serializable
@SerialName("event.push")
data class EventPush(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("event") val event: String,
    @SerialName("payload") val payload: JsonObject
) : VanessaProtocolMessage() {
    override val type: String = "event.push"
}

/**
 * ping message.
 */
@Serializable
@SerialName("ping")
data class Ping(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("sentAt") val sentAt: Long
) : VanessaProtocolMessage() {
    override val type: String = "ping"
}

/**
 * pong message.
 */
@Serializable
@SerialName("pong")
data class Pong(
    @SerialName("v") override val v: Int,
    @SerialName("id") override val id: String,
    @SerialName("timestamp") override val timestamp: Long,
    @SerialName("receivedAt") val receivedAt: Long
) : VanessaProtocolMessage() {
    override val type: String = "pong"
}
