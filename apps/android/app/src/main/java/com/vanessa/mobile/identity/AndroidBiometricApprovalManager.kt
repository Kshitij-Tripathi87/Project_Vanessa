package com.vanessa.mobile.identity

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.vanessa.protocol.v2.JcsCanonicalizer
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.Signature
import java.util.Base64
import kotlin.coroutines.resume

data class BiometricApprovalProof(
    val approvedAt: Long,
    val keyId: String,
    val signature: String,
)

/** Runs BiometricPrompt with a Keystore CryptoObject; no boolean-only approval path exists. */
class AndroidBiometricApprovalManager(
    private val keyStore: AndroidBiometricApprovalKeyStore = AndroidBiometricApprovalKeyStore(),
) {
    suspend fun authorize(
        activity: FragmentActivity,
        approvalId: String,
        taskId: String,
        actionHash: String,
        consequence: String,
    ): BiometricApprovalProof? {
        val biometricManager = BiometricManager.from(activity)
        if (biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) !=
            BiometricManager.BIOMETRIC_SUCCESS) return null

        val identity = try {
            keyStore.loadOrCreate()
        } catch (_: Exception) {
            return null
        }
        val approvedAt = System.currentTimeMillis()
        val signedMaterial = buildJsonObject {
            put("approvalId", approvalId)
            put("taskId", taskId)
            put("actionHash", actionHash)
            put("decision", "approved")
            put("approvedAt", approvedAt)
            put("method", "biometric_strong")
            put("keyId", identity.keyId)
        }
        val signature = try {
            keyStore.prepareSignature(
                identity,
                JcsCanonicalizer.canonicalize(signedMaterial).toByteArray(Charsets.UTF_8),
            )
        } catch (_: Exception) {
            return null
        }

        return suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val authenticatedSignature: Signature =
                                result.cryptoObject?.signature ?: signature
                            val signed = authenticatedSignature.sign()
                            if (continuation.isActive) {
                                continuation.resume(
                                    BiometricApprovalProof(
                                        approvedAt = approvedAt,
                                        keyId = identity.keyId,
                                        signature = Base64.getUrlEncoder().withoutPadding().encodeToString(signed),
                                    )
                                )
                            }
                        } catch (_: Exception) {
                            if (continuation.isActive) continuation.resume(null)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) continuation.resume(null)
                    }
                },
            )
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Approve Vanessa action")
                    .setSubtitle(consequence.take(100))
                    .setDescription("Verify your identity to authorize this exact PC action.")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText("Cancel")
                    .build(),
                BiometricPrompt.CryptoObject(signature),
            )
        }
    }
}
