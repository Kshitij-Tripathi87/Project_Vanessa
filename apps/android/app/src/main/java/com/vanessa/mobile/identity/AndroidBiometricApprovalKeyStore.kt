package com.vanessa.mobile.identity

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** Separate identity key. Every use requires strong biometric authentication. */
class AndroidBiometricApprovalKeyStore(
    private val alias: String = DEFAULT_ALIAS,
) {
    @Synchronized
    fun loadOrCreate(): AndroidBiometricApprovalIdentity {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        val entry = existing ?: generateEntry(store)
        val publicKey = entry.certificate.publicKey
        require(RemoteEnvelopeCrypto.isP256(publicKey)) {
            "Stored biometric approval identity is not a P-256 key."
        }
        return AndroidBiometricApprovalIdentity(
            keyId = RemoteEnvelopeCrypto.keyId(publicKey.encoded),
            publicKeyBase64Url = RemoteEnvelopeCrypto.publicKeyBase64Url(publicKey.encoded),
            privateKey = entry.privateKey,
        )
    }

    /** Prepare a signature and bind the exact approval bytes before prompting. */
    fun prepareSignature(identity: AndroidBiometricApprovalIdentity, payload: ByteArray): Signature {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(identity.privateKey)
        signature.update(payload)
        return signature
    }

    @Synchronized
    fun deleteForRePairing() {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private fun generateEntry(store: KeyStore): KeyStore.PrivateKeyEntry {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        } else {
            // -1 means authentication is required for every cryptographic use.
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(builder.build())
        generator.generateKeyPair()
        return store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Android Keystore did not return the biometric approval key.")
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "com.vanessa.remote.approval.es256.biometric.v2"
    }
}

data class AndroidBiometricApprovalIdentity internal constructor(
    val keyId: String,
    val publicKeyBase64Url: String,
    internal val privateKey: java.security.PrivateKey,
)
