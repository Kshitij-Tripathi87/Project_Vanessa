package com.vanessa.mobile.identity

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.vanessa.protocol.v2.JcsCanonicalizer
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class AndroidApprovalIdentity(
    val keyId: String,
    val publicKeyBase64Url: String,
)

data class RemoteApprovalBinding(
    val approvalId: String,
    val taskId: String,
    val actionHash: String,
    val approvedAt: Long,
)

class AndroidRemoteApprovalKeyStore(
    private val alias: String = DEFAULT_ALIAS,
) {
    /** Generate/read a distinct biometric-only key. Unsupported devices fail closed. */
    @Synchronized
    fun loadOrCreate(): AndroidApprovalIdentity {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        val entry = existing ?: generateEntry()
        val publicKey = entry.certificate.publicKey as? ECPublicKey
            ?: throw IllegalStateException("Biometric approval identity is not an EC key.")
        require(RemoteEnvelopeCrypto.isP256(publicKey)) { "Biometric approval identity must use P-256."}
        return AndroidApprovalIdentity(
            keyId = RemoteEnvelopeCrypto.keyId(publicKey.encoded),
            publicKeyBase64Url = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey.encoded),
        )
    }

    suspend fun signWithStrongBiometricSuspend(
        activity: FragmentActivity,
        binding: RemoteApprovalBinding,
        promptSubtitle: String,
    ): Pair<AndroidApprovalIdentity, String> = suspendCancellableCoroutine { continuation ->
        try {
            val identity = loadOrCreate()
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val entry = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
                ?: throw IllegalStateException("Biometric approval key is unavailable.")
            val signing = Signature.getInstance("SHA256withECDSA").apply { initSign(entry.privateKey) }
            val callbackExecutor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                activity,
                callbackExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (!continuation.isActive) return
                        try {
                            val cryptoSignature = result.cryptoObject?.signature
                                ?: throw IllegalStateException("Biometric authorization returned no signing operation.")
                            cryptoSignature.update(canonicalApprovalBytes(binding))
                            val proof = Base64.getUrlEncoder().withoutPadding().encodeToString(cryptoSignature.sign())
                            continuation.resume(identity to proof)
                        } catch (error: Exception) {
                            continuation.resumeWithException(error)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                SecurityException("Biometric approval was not completed: $errString")
                            )
                        }
                    }

                    override fun onAuthenticationFailed() {
                        // Keep the system prompt open; it will report a terminal error if cancelled.
                    }
                }
            )
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Approve Vanessa action")
                .setSubtitle(promptSubtitle.take(120))
                .setDescription("This approval is cryptographically bound to the exact task and action.")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signing))
        } catch (error: Exception) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }
    }

    @Synchronized
    fun delete() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private fun generateEntry(): KeyStore.PrivateKeyEntry {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationValidityDurationSeconds(-1)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        }
        generator.initialize(builder.build())
        generator.generateKeyPair()
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Android Keystore did not return the biometric key.")
    }

    private fun canonicalApprovalBytes(binding: RemoteApprovalBinding): ByteArray {
        val value = buildJsonObject {
            put("approvalId", binding.approvalId)
            put("taskId", binding.taskId)
            put("actionHash", binding.actionHash)
            put("decision", "approved")
            put("approvedAt", binding.approvedAt)
            put("method", "biometric_strong")
        }
        return JcsCanonicalizer.canonicalize(value).toByteArray(Charsets.UTF_8)
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "com.vanessa.remote.approval.biometric.es256.v2"
    }
}

