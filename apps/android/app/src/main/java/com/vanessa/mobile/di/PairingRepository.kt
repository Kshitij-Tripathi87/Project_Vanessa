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

/** Pairing state captured from the PC's QR payload. */
data class StoredPairing(
    val pcIp: String,
    val port: Int,
    val pairingCode: String,
    val expiresAt: Long,
    /** Assigned by the PC when the code is redeemed; null until then. */
    val deviceId: String? = null,
    /** Per-device HMAC secret; only ever received from the PC. */
    val secret: String? = null,
)

/** Public-only trust configuration for protocol v2. Private keys remain in Android Keystore. */
data class StoredRemoteV2Pairing(
    val wsUrl: String,
    val pcKeyId: String,
    val pcPublicKeySpki: String,
    val pcName: String,
    val deviceId: String,
    val grantedScopesJson: String,
)

/**
 * Persists the PC address, the short-lived pairing code, and (after
 * redemption) the device id and secret issued by the PC.
 */
@Singleton
class PairingRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>
) {
    private object Keys {
        val PC_IP = stringPreferencesKey("paired_pc_ip")
        val PC_PORT = intPreferencesKey("paired_pc_port")
        val PAIRING_CODE = stringPreferencesKey("pairing_code")
        val PAIRING_EXPIRES_AT = longPreferencesKey("pairing_expires_at")
        val DEVICE_ID = stringPreferencesKey("paired_device_id")
        val DEVICE_SECRET = stringPreferencesKey("paired_device_secret")
        val REMOTE_V2_WS_URL = stringPreferencesKey("remote_v2_ws_url")
        val REMOTE_V2_PC_KEY_ID = stringPreferencesKey("remote_v2_pc_key_id")
        val REMOTE_V2_PC_PUBLIC_KEY = stringPreferencesKey("remote_v2_pc_public_key")
        val REMOTE_V2_PC_NAME = stringPreferencesKey("remote_v2_pc_name")
        val REMOTE_V2_DEVICE_ID = stringPreferencesKey("remote_v2_device_id")
        val REMOTE_V2_GRANTED_SCOPES = stringPreferencesKey("remote_v2_granted_scopes")
    }

    val pairing: Flow<StoredPairing?> = dataStore.data.map { preferences ->
        val ip = preferences[Keys.PC_IP]
        val code = preferences[Keys.PAIRING_CODE]
        if (ip == null || code == null) null
        else StoredPairing(
            pcIp = ip,
            port = preferences[Keys.PC_PORT] ?: 8765,
            pairingCode = code,
            expiresAt = preferences[Keys.PAIRING_EXPIRES_AT] ?: 0L,
            deviceId = preferences[Keys.DEVICE_ID],
            secret = preferences[Keys.DEVICE_SECRET],
        )
    }

    val remoteV2Pairing: Flow<StoredRemoteV2Pairing?> = dataStore.data.map { preferences ->
        val wsUrl = preferences[Keys.REMOTE_V2_WS_URL]
        val keyId = preferences[Keys.REMOTE_V2_PC_KEY_ID]
        val publicKey = preferences[Keys.REMOTE_V2_PC_PUBLIC_KEY]
        val deviceId = preferences[Keys.REMOTE_V2_DEVICE_ID]
        if (wsUrl == null || keyId == null || publicKey == null || deviceId == null) null
        else StoredRemoteV2Pairing(
            wsUrl = wsUrl,
            pcKeyId = keyId,
            pcPublicKeySpki = publicKey,
            pcName = preferences[Keys.REMOTE_V2_PC_NAME] ?: "Vanessa PC",
            deviceId = deviceId,
            grantedScopesJson = preferences[Keys.REMOTE_V2_GRANTED_SCOPES] ?: "[]",
        )
    }

    suspend fun saveRemoteV2Pairing(pairing: StoredRemoteV2Pairing) {
        dataStore.edit { preferences ->
            preferences[Keys.REMOTE_V2_WS_URL] = pairing.wsUrl
            preferences[Keys.REMOTE_V2_PC_KEY_ID] = pairing.pcKeyId
            preferences[Keys.REMOTE_V2_PC_PUBLIC_KEY] = pairing.pcPublicKeySpki
            preferences[Keys.REMOTE_V2_PC_NAME] = pairing.pcName
            preferences[Keys.REMOTE_V2_DEVICE_ID] = pairing.deviceId
            preferences[Keys.REMOTE_V2_GRANTED_SCOPES] = pairing.grantedScopesJson
        }
    }

    suspend fun clearRemoteV2Pairing() {
        dataStore.edit { preferences ->
            preferences.remove(Keys.REMOTE_V2_WS_URL)
            preferences.remove(Keys.REMOTE_V2_PC_KEY_ID)
            preferences.remove(Keys.REMOTE_V2_PC_PUBLIC_KEY)
            preferences.remove(Keys.REMOTE_V2_PC_NAME)
            preferences.remove(Keys.REMOTE_V2_DEVICE_ID)
            preferences.remove(Keys.REMOTE_V2_GRANTED_SCOPES)
        }
    }

    suspend fun savePairing(pairing: StoredPairing) {
        dataStore.edit { preferences ->
            preferences[Keys.PC_IP] = pairing.pcIp
            preferences[Keys.PC_PORT] = pairing.port
            preferences[Keys.PAIRING_CODE] = pairing.pairingCode
            preferences[Keys.PAIRING_EXPIRES_AT] = pairing.expiresAt
            pairing.deviceId?.let { preferences[Keys.DEVICE_ID] = it }
            pairing.secret?.let { preferences[Keys.DEVICE_SECRET] = it }
        }
    }

    suspend fun clear() {
        dataStore.edit { preferences ->
            preferences.remove(Keys.PC_IP)
            preferences.remove(Keys.PC_PORT)
            preferences.remove(Keys.PAIRING_CODE)
            preferences.remove(Keys.PAIRING_EXPIRES_AT)
            preferences.remove(Keys.DEVICE_ID)
            preferences.remove(Keys.DEVICE_SECRET)
        }
    }
}
