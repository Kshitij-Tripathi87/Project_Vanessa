package com.vanessa.mobile.identity

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Separate approval identity. It is created only on Android 11+ when strong
 * biometrics are enrolled, is hardware-backed, and requires a fresh biometric
 * auth token for every ES256 signature.
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
            if (!keyInfo.isInsideSecureHardware) return null
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

    @Synchronized
    fun createSignature(): Signature {
        val identity = loadOrCreate()
            ?: throw IllegalStateException("A hardware-backed strong biometric approval key is unavailable. Re-pair after enrolling strong biometrics.")
        return Signature.getInstance("SHA256withECDSA").apply {
            initSign(identity.privateKey)
        }
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
