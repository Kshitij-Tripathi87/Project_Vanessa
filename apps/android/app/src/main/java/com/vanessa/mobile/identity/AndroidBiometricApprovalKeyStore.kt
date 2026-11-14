package com.vanessa.mobile.identity

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.vanessa.protocol.v2.JcsCanonicalizer
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class BiometricApprovalPublicIdentity(
    val keyId: String,
    val publicKeySpkiBase64Url: String,
)

/** Separate Keystore key for consent; it is not the transport identity key. */
class AndroidBiometricApprovalKeyStore(
    private val alias: String = DEFAULT_ALIAS,
) {
    @Synchronized
    fun loadOrCreate(): BiometricApprovalPublicIdentity {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        val entry = existing ?: generateEntry(store)
        val privateKeyInfo = KeyFactory.getInstance(entry.privateKey.algorithm, ANDROID_KEYSTORE)
            .getKeySpec(entry.privateKey, KeyInfo::class.java)
        require(privateKeyInfo.isInsideSecureHardware) {
            "This device does not provide a hardware-backed Android Keystore key. Destructive remote approvals are disabled."
        }
        val publicKey = entry.certificate.publicKey
        require(publicKey.algorithm.equals("EC", ignoreCase = true))
        require(com.vanessa.protocol.v2.RemoteEnvelopeCrypto.isP256(publicKey))
        return BiometricApprovalPublicIdentity(
            keyId = com.vanessa.protocol.v2.RemoteEnvelopeCrypto.keyId(publicKey.encoded),
            publicKeySpkiBase64Url = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey.encoded),
        )
    }

    /** Uses a CryptoObject so Android releases this key only after strong biometric auth. */
    suspend fun signApproval(
        activity: FragmentActivity,
        taskId: String,
        approvalId: String,
        actionHash: String,
        approvedAt: Long = System.currentTimeMillis(),
    ): BiometricApprovalProof = suspendCancellableCoroutine { continuation ->
        try {
            val availability = BiometricManager.from(activity).canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG,
            )
            if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
                throw IllegalStateException("A strong enrolled biometric is required for remote approval.")
            }
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
                ?: throw IllegalStateException("Biometric approval key is not provisioned. Pair this phone again.")
            val publicIdentity = loadOrCreate()
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(entry.privateKey)
            val binding = buildJsonObject {
                put("taskId", taskId)
                put("approvalId", approvalId)
                put("actionHash", actionHash)
                put("decision", "approved")
                put("approvedAt", approvedAt)
                put("method", "biometric_strong")
            }
            val canonicalBytes = JcsCanonicalizer.canonicalize(binding).toByteArray(Charsets.UTF_8)
            lateinit var prompt: BiometricPrompt
            prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val authorized = result.cryptoObject?.signature
                                ?: throw IllegalStateException("Biometric authorization returned no signing operation.")
                            authorized.update(canonicalBytes)
                            val signed = authorized.sign()
                            val proof = BiometricApprovalProof(
                                keyId = publicIdentity.keyId,
                                signature = Base64.getUrlEncoder().withoutPadding().encodeToString(signed),
                                signedAt = approvedAt,
                            )
                            if (continuation.isActive) continuation.resume(proof)
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(error)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                IllegalStateException("Biometric approval was not completed: " + errString),
                            )
                        }
                    }
                },
            )
            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Approve Vanessa action")
                .setSubtitle("Confirm this exact PC action with a strong biometric")
                .setDescription("Approval is bound to task " + taskId + " and cannot be reused.")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signature))
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
        } catch (error: Exception) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }
    }

    @Synchronized
    fun delete() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private fun generateEntry(store: KeyStore): KeyStore.PrivateKeyEntry {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        generator.initialize(builder.build())
        generator.generateKeyPair()
        return store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Android Keystore did not return the biometric approval key.")
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "com.vanessa.remote.approval.es256.v2"
    }
}

data class BiometricApprovalProof(
    val keyId: String,
    val signature: String,
    val signedAt: Long,
)
