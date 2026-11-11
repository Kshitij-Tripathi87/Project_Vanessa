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
)

/**
 * Persists the PC address and short-lived pairing code.
 *
 * There is no long-lived secret stored on the phone yet, because the PC
 * gateway does not expose pairing-code redemption; the code is kept so the
 * redemption call can be added without re-scanning.
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
        )
    }

    suspend fun savePairing(pairing: StoredPairing) {
        dataStore.edit { preferences ->
            preferences[Keys.PC_IP] = pairing.pcIp
            preferences[Keys.PC_PORT] = pairing.port
            preferences[Keys.PAIRING_CODE] = pairing.pairingCode
            preferences[Keys.PAIRING_EXPIRES_AT] = pairing.expiresAt
        }
    }

    suspend fun clear() {
        dataStore.edit { preferences ->
            preferences.remove(Keys.PC_IP)
            preferences.remove(Keys.PC_PORT)
            preferences.remove(Keys.PAIRING_CODE)
            preferences.remove(Keys.PAIRING_EXPIRES_AT)
        }
    }
}
