/**
 * Auto-generated from protocol-v1.schema.json.
 * DO NOT EDIT BY HAND — regenerate with
 *   pnpm --filter @vanessa/protocol build
 */
package com.vanessa.mobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Protocol version. Must match packages/protocol/src/protocol.ts.
 */
const val PROTOCOL_VERSION: Int = 1

/**
 * Discriminated union over all message types the phone <-> PC link carries.
 *
 * The `type` field is the discriminator. The PC validates inbound messages
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
data class TaskSubmit(
    @SerialName("v") val v: Double,
    @SerialName("id") val id: String,
    @SerialName("timestamp") val timestamp: Long,
    @SerialName("idempotencyKey") val idempotencyKey: String,
    @SerialName("tool") val tool: String,
    @SerialName("args") val args: Map<String, Any>,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.submit"
}

/**
 * task.accepted message.
 */
@Serializable
data class TaskAccepted(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.accepted"
}

/**
 * task.progress message.
 */
@Serializable
data class TaskProgress(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId,
    @SerialName("state") val state: String,
    @SerialName("message") val message: String = "",
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.progress"
}

/**
 * task.confirm_required message.
 */
@Serializable
data class TaskConfirm_required(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId,
    @SerialName("summary") val summary: String,
    @SerialName("actionHash") val actionHash: String,
    @SerialName("expiresAt") val expiresAt: Long
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.confirm_required"
}

/**
 * task.confirm message.
 */
@Serializable
data class TaskConfirm(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId,
    @SerialName("approved") val approved: Boolean,
    @SerialName("actionHash") val actionHash: String,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.confirm"
}

/**
 * task.result message.
 */
@Serializable
data class TaskResult(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId,
    @SerialName("status") val status: String,
    @SerialName("result") val result: Any = null
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.result"
}

/**
 * task.error message.
 */
@Serializable
data class TaskError(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId = null,
    @SerialName("code") val code: String,
    @SerialName("message") val message: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.error"
}

/**
 * task.cancel message.
 */
@Serializable
data class TaskCancel(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("taskId") val taskId: taskId,
    @SerialName("signature") val signature: String,
    @SerialName("nonce") val nonce: String
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "task.cancel"
}

/**
 * manifest.sync message.
 */
@Serializable
data class ManifestSync(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("manifestVersion") val manifestVersion: String,
    @SerialName("tools") val tools: List<Any>
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "manifest.sync"
}

/**
 * event.push message.
 */
@Serializable
data class EventPush(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("event") val event: String,
    @SerialName("payload") val payload: Map<String, Any>
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "event.push"
}

/**
 * ping message.
 */
@Serializable
data class Ping(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("sentAt") val sentAt: Long
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "ping"
}

/**
 * pong message.
 */
@Serializable
data class Pong(
    @SerialName("v") val v: v,
    @SerialName("id") val id: id,
    @SerialName("timestamp") val timestamp: timestamp,
    @SerialName("receivedAt") val receivedAt: Long
) : VanessaProtocolMessage() {
    override val v: Int = PROTOCOL_VERSION
    override val type: String = "pong"
}
