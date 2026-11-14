package com.vanessa.mobile.identity

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Separate approval identity. The key is generated in Android Keystore and
 * requires a fresh strong-biometric authentication for every signature.
 * The returned CryptoObject is the only signing handle exposed to the UI.
 */
class AndroidRemoteApprovalKeyStore(
    private val context: Context,
    private val alias: String = DEFAULT_ALIAS,
) {
    @Synchronized
    fun loadOrCreate(): AndroidRemoteApprovalIdentity? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        if (BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            != BiometricManager.BIOMETRIC_SUCCESS) return null

        return try {
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val entry = (store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry) ?: generateEntry(store)
            val privateKey = entry.privateKey
            val keyInfo = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
                .getKeySpec(privateKey, KeyInfo::class.java)
            if (!keyInfo.isInsideSecureHardware ||
                !keyInfo.isUserAuthenticationRequired ||
                keyInfo.userAuthenticationValidityDurationSeconds != -1 ||
                keyInfo.userAuthenticationType and KeyProperties.AUTH_BIOMETRIC_STRONG == 0) return null
            val publicKey = entry.certificate.publicKey
            require(RemoteEnvelopeCrypto.isP256(publicKey)) { "Approval key is not P-256." }
            AndroidRemoteApprovalIdentity(
                keyId = RemoteEnvelopeCrypto.keyId(publicKey.encoded),
                publicKey = publicKey,
                privateKey = privateKey,
            )
        } catch (_: Exception) {
            // Key invalidation, no secure hardware, or unavailable auth must
            // never degrade to the normal session identity.
            null
        }
    }

    /**
     * Starts the Android system biometric prompt using a Signature initialized
     * with the non-exportable key. This is the supported way to authorize a
     * per-use Android Keystore signing operation.
     */
    fun authenticateForSignature(
        activity: FragmentActivity,
        onSuccess: (String, Signature) -> Unit,
        onFailure: (String) -> Unit,
    ) {
        val identity = try { loadOrCreate() } catch (error: Exception) {
            onFailure(error.message ?: "Unable to load the biometric approval key.")
            return
        }
        if (identity == null) {
            onFailure("A hardware-backed strong-biometric approval key is unavailable.")
            return
        }
        val signature = try {
            Signature.getInstance("SHA256withECDSA").apply { initSign(identity.privateKey) }
        } catch (error: Exception) {
            onFailure(error.message ?: "Unable to initialize the biometric approval key.")
            return
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val authorized = result.cryptoObject?.signature
                    if (authorized == null) {
                        onFailure("Android did not return the biometric-authorized signing object.")
                    } else {
                        onSuccess(identity.keyId, authorized)
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    onFailure(errString.toString())
                }

                override fun onAuthenticationFailed() {
                    // Android may continue offering retries; do not send a proof.
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Approve protected PC action")
            .setSubtitle("Verify with a strong biometric")
            .setDescription("The signature authorizes only the exact action shown in Vanessa.")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
    }

    @Synchronized
    fun delete() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private fun generateEntry(store: KeyStore): KeyStore.PrivateKeyEntry {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(
                    0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG,
                )
                .setInvalidatedByBiometricEnrollment(true)
                .build(),
        )
        generator.generateKeyPair()
        return store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Android Keystore did not return the approval key.")
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "com.vanessa.remote.approval.biometric.es256.v2"
    }
}

data class AndroidRemoteApprovalIdentity internal constructor(
    val keyId: String,
    val publicKey: java.security.PublicKey,
    internal val privateKey: PrivateKey,
) {
    val publicKeyBase64Url: String
        get() = RemoteEnvelopeCrypto.publicKeyBase64Url(publicKey.encoded)
}
