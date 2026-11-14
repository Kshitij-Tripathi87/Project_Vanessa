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

/**
 * Locally stored, public pairing metadata. The Android private identity stays
 * in Android Keystore; no shared HMAC secret or PC private material is stored.
 */
data class StoredPairing(
    val pcIp: String,
    val port: Int,
    val pairingCode: String,
    val expiresAt: Long,
    val deviceId: String? = null,
    val pairingId: String = "",
    val endpoint: String = "",
    val pcKeyId: String = "",
    val pcPublicKey: String = "",
)

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
        val ENDPOINT = stringPreferencesKey("paired_pc_endpoint_v2")
        val PC_KEY_ID = stringPreferencesKey("paired_pc_key_id_v2")
        val PC_PUBLIC_KEY = stringPreferencesKey("paired_pc_public_key_v2")
        // Legacy v1 secret is removed whenever a v2 pairing is persisted.
        val LEGACY_DEVICE_SECRET = stringPreferencesKey("paired_device_secret")
    }

    val pairing: Flow<StoredPairing?> = dataStore.data.map { preferences ->
        val endpoint = preferences[Keys.ENDPOINT]
        val pcKeyId = preferences[Keys.PC_KEY_ID]
        val pcPublicKey = preferences[Keys.PC_PUBLIC_KEY]
        val ip = preferences[Keys.PC_IP]
        if (endpoint.isNullOrBlank() || pcKeyId.isNullOrBlank() || pcPublicKey.isNullOrBlank() || ip.isNullOrBlank()) {
            null
        } else {
            StoredPairing(
                pcIp = ip,
                port = preferences[Keys.PC_PORT] ?: 443,
                pairingCode = "",
                expiresAt = preferences[Keys.PAIRING_EXPIRES_AT] ?: 0L,
                deviceId = preferences[Keys.DEVICE_ID],
                endpoint = endpoint,
                pcKeyId = pcKeyId,
                pcPublicKey = pcPublicKey,
            )
        }
    }

    suspend fun savePairing(pairing: StoredPairing) {
        require(pairing.endpoint.isNotBlank() && pairing.pcKeyId.isNotBlank() && pairing.pcPublicKey.isNotBlank()) {
            "A v2 pairing must include its WSS endpoint and pinned PC public identity."
        }
        dataStore.edit { preferences ->
            preferences[Keys.PC_IP] = pairing.pcIp
            preferences[Keys.PC_PORT] = pairing.port
            preferences[Keys.ENDPOINT] = pairing.endpoint
            preferences[Keys.PC_KEY_ID] = pairing.pcKeyId
            preferences[Keys.PC_PUBLIC_KEY] = pairing.pcPublicKey
            preferences[Keys.PAIRING_EXPIRES_AT] = pairing.expiresAt
            if (!pairing.deviceId.isNullOrBlank()) preferences[Keys.DEVICE_ID] = pairing.deviceId
            else preferences.remove(Keys.DEVICE_ID)
            preferences.remove(Keys.PAIRING_CODE)
            preferences.remove(Keys.LEGACY_DEVICE_SECRET)
        }
    }

    suspend fun clear() {
        dataStore.edit { preferences ->
            preferences.remove(Keys.PC_IP)
            preferences.remove(Keys.PC_PORT)
            preferences.remove(Keys.ENDPOINT)
            preferences.remove(Keys.PC_KEY_ID)
            preferences.remove(Keys.PC_PUBLIC_KEY)
            preferences.remove(Keys.PAIRING_CODE)
            preferences.remove(Keys.PAIRING_EXPIRES_AT)
            preferences.remove(Keys.DEVICE_ID)
            preferences.remove(Keys.LEGACY_DEVICE_SECRET)
        }
    }
}
