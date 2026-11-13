package com.vanessa.mobile.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.vanessa.protocol.v2.RemoteEnvelopeCrypto
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Device identity backed by Android Keystore. The private key is non-exportable;
 * only the SPKI public key and its protocol keyId may leave the phone.
 */
class AndroidRemoteIdentityStore(
    private val alias: String = DEFAULT_ALIAS,
) {
    @Synchronized
    fun loadOrCreate(): AndroidRemoteIdentity {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        val entry = existing ?: generateEntry(store)
        val publicKey = entry.certificate.publicKey
        val privateKey = entry.privateKey
        require(publicKey.algorithm.equals("EC", ignoreCase = true)) { "Stored remote identity is not an EC key" }
        require(RemoteEnvelopeCrypto.isP256(publicKey)) { "Stored remote identity is not a P-256 key" }
        return AndroidRemoteIdentity(
            keyId = RemoteEnvelopeCrypto.keyId(publicKey.encoded),
            publicKey = publicKey,
            privateKey = privateKey,
        )
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
                .setUserAuthenticationRequired(false)
                .build()
        )
        generator.generateKeyPair()
        return store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: throw IllegalStateException("Android Keystore did not return the generated identity")
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "com.vanessa.remote.identity.es256.v2"
    }
}

data class AndroidRemoteIdentity internal constructor(
    val keyId: String,
    val publicKey: PublicKey,
    internal val privateKey: PrivateKey,
) {
    /** SPKI DER, base64url without padding, as required by protocol v2. */
    val publicKeyBase64Url: String
        get() = RemoteEnvelopeCrypto.publicKeyBase64Url(publicKey.encoded)
}
