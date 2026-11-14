package com.vanessa.mobile.di

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/** PC identity pin and one-time pairing data scanned from a v2 QR code. */
data class StoredPairing(
    val pcIp: String,
    val port: Int,
    val pairingId: String,
    val pairingCode: String,
    val expiresAt: Long,
    val pcKeyId: String,
    val pcPublicKey: String,
    val scheme: String = "wss",
    val path: String = "/remote-v2",
    /** Set only after explicit approval in the PC's local UI. */
    val deviceId: String? = null,
)

/**
 * Stores the PC's public identity pin and the short-lived pairing claim.
 * The phone's private identity key remains in Android Keystore. No shared
 * HMAC secret or exportable private key is stored here.
 */
@Singleton
class PairingRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>
) {
    private object Keys {
        val PC_IP = stringPreferencesKey("remote_v2_pc_host")
        val PC_PORT = intPreferencesKey("remote_v2_pc_port")
        val PAIRING_ID = stringPreferencesKey("remote_v2_pairing_id")
        val PAIRING_CODE = stringPreferencesKey("remote_v2_pairing_code")
        val PAIRING_EXPIRES_AT = longPreferencesKey("remote_v2_pairing_expires_at")
        val PC_KEY_ID = stringPreferencesKey("remote_v2_pc_key_id")
        val PC_PUBLIC_KEY = stringPreferencesKey("remote_v2_pc_public_key")
        val SCHEME = stringPreferencesKey("remote_v2_scheme")
        val PATH = stringPreferencesKey("remote_v2_path")
        val DEVICE_ID = stringPreferencesKey("remote_v2_device_id")
    }

    val pairing: Flow<StoredPairing?> = dataStore.data.map { preferences ->
        val host = preferences[Keys.PC_IP]
        val pairingId = preferences[Keys.PAIRING_ID]
        val code = preferences[Keys.PAIRING_CODE]
        val keyId = preferences[Keys.PC_KEY_ID]
        val publicKey = preferences[Keys.PC_PUBLIC_KEY]
        if (host == null || pairingId == null || code == null || keyId == null || publicKey == null) null
        else StoredPairing(
            pcIp = host,
            port = preferences[Keys.PC_PORT] ?: 43443,
            pairingId = pairingId,
            pairingCode = code,
            expiresAt = preferences[Keys.PAIRING_EXPIRES_AT] ?: 0L,
            pcKeyId = keyId,
            pcPublicKey = publicKey,
            scheme = preferences[Keys.SCHEME] ?: "wss",
            path = preferences[Keys.PATH] ?: "/remote-v2",
            deviceId = preferences[Keys.DEVICE_ID],
        )
    }

    suspend fun savePairing(pairing: StoredPairing) {
        dataStore.edit { preferences ->
            preferences[Keys.PC_IP] = pairing.pcIp
            preferences[Keys.PC_PORT] = pairing.port
            preferences[Keys.PAIRING_ID] = pairing.pairingId
            preferences[Keys.PAIRING_CODE] = pairing.pairingCode
            preferences[Keys.PAIRING_EXPIRES_AT] = pairing.expiresAt
            preferences[Keys.PC_KEY_ID] = pairing.pcKeyId
            preferences[Keys.PC_PUBLIC_KEY] = pairing.pcPublicKey
            preferences[Keys.SCHEME] = pairing.scheme
            preferences[Keys.PATH] = pairing.path
            if (pairing.deviceId == null) preferences.remove(Keys.DEVICE_ID)
            else preferences[Keys.DEVICE_ID] = pairing.deviceId
        }
    }

    suspend fun clear() {
        dataStore.edit { preferences ->
            preferences.remove(Keys.PC_IP)
            preferences.remove(Keys.PC_PORT)
            preferences.remove(Keys.PAIRING_ID)
            preferences.remove(Keys.PAIRING_CODE)
            preferences.remove(Keys.PAIRING_EXPIRES_AT)
            preferences.remove(Keys.PC_KEY_ID)
            preferences.remove(Keys.PC_PUBLIC_KEY)
            preferences.remove(Keys.SCHEME)
            preferences.remove(Keys.PATH)
            preferences.remove(Keys.DEVICE_ID)
        }
    }
}
