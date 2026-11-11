package com.vanessa.mobile.di

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.mutations
import androidx.datastore.preferences.preferencesDataStore
import androidx.datastore.preferences.preferencesKey
import androidx.datastore.rxjava3.RxDataStore
import androidx.startup.Initializer
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.android.scopes.ActivityRetainedScoped
import dagger.hilt.android.scopes.Singleton
import dagger.Module
import dagger.Provides
import io.reactivex.rxjava3.core.Completable
import io.reactivex.rxjava3.core.Single
import javax.inject.Inject

/**
 * DataStore module for persisting user preferences
 */
@Module
@InstallIn(SingletonComponent::class)
object DataStoreModule {

    // Keys for DataStore
    private const val KEY_PAIRED_PC_IP = "paired_pc_ip"
    private const val KEY_PAIRED_PC_PORT = "paired_pc_port"
    private const val KEY_PAIRED_DEVICE_ID = "paired_device_id"
    private const val KEY_PAIRED_DEVICE_SECRET = "paired_device_secret"
    private const val KEY_DEVICE_NAME = "device_name"

    @Provides
    @Singleton
    fun provideDataStore(@ApplicationContext context: Context): RxDataStore<Preferences> =
        context.preferencesDataStore(name = "vanessa_preferences")

    @Provides
    @Singleton
    fun providePairedPcIp(dataStore: RxDataStore<Preferences>) = dataStore.data
        .map { it[KEY_PAIRED_PC_IP] }
        .firstElement()

    @Provides
    @Singleton
    fun providePairedPcPort(dataStore: RxDataStore<Preferences>) = dataStore.data
        .map { it[KEY_PAIRED_PC_PORT] ?: 8765 }
        .firstElement()

    @Provides
    @Singleton
    fun providePairedDeviceId(dataStore: RxDataStore<Preferences>) = dataStore.data
        .map { it[KEY_PAIRED_DEVICE_ID] }
        .firstElement()

    @Provides
    @Singleton
    fun providePairedDeviceSecret(dataStore: RxDataStore<Preferences>) = dataStore.data
        .map { it[KEY_PAIRED_DEVICE_SECRET] }
        .firstElement()

    @Provides
    @Singleton
    fun provideDeviceName(dataStore: RxDataStore<Preferences>) = dataStore.data
        .map { it[KEY_DEVICE_NAME] ?: "Vanessa Phone" }
        .firstElement()
}

/**
 * Repository for managing paired device data
 */
class PairingRepository @Inject constructor(
    private val dataStore: RxDataStore<Preferences>
) {

    companion object {
        private const val KEY_PAIRED_PC_IP = "paired_pc_ip"
        private const val KEY_PAIRED_PC_PORT = "paired_pc_port"
        private const val KEY_PAIRED_DEVICE_ID = "paired_device_id"
        private const val KEY_PAIRED_DEVICE_SECRET = "paired_device_secret"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_IS_PAIRED = "is_paired"
    }

    private val isPairedKey = preferencesKey<Boolean>(KEY_IS_PAIRED)
    private val pcIpKey = preferencesKey<String>(KEY_PAIRED_PC_IP)
    private val pcPortKey = preferencesKey<Int>(KEY_PAIRED_PC_PORT)
    private val deviceIdKey = preferencesKey<String>(KEY_PAIRED_DEVICE_ID)
    private val deviceSecretKey = preferencesKey<String>(KEY_PAIRED_DEVICE_SECRET)
    private val deviceNameKey = preferencesKey<String>(KEY_DEVICE_NAME)

    /**
     * Check if device is paired
     */
    fun isPaired(): Single<Boolean> =
        dataStore.data
            .map { it[isPairedKey] ?: false }
            .firstElement()

    /**
     * Get paired PC IP
     */
    fun getPairedPcIp(): Single<String?> =
        dataStore.data
            .map { it[pcIpKey] }
            .firstElement()

    /**
     * Get paired PC port
     */
    fun getPairedPcPort(): Single<Int> =
        dataStore.data
            .map { it[pcPortKey] ?: 8765 }
            .firstElement()

    /**
     * Get paired device ID
     */
    fun getPairedDeviceId(): Single<String?> =
        dataStore.data
            .map { it[deviceIdKey] }
            .firstElement()

    /**
     * Get paired device secret
     */
    fun getPairedDeviceSecret(): Single<String?> =
        dataStore.data
            .map { it[deviceSecretKey] }
            .firstElement()

    /**
     * Save pairing information
     */
    fun savePairing(
        pcIp: String,
        pcPort: Int,
        deviceId: String,
        deviceSecret: String,
        deviceName: String = "Vanessa Phone"
    ): Completable =
        dataStore.updateDataAsync { preferences ->
            preferences.mutations {
                it[isPairedKey] = true
                it[pcIpKey] = pcIp
                it[pcPortKey] = pcPort
                it[deviceIdKey] = deviceId
                it[deviceSecretKey] = deviceSecret
                it[deviceNameKey] = deviceName
            }
        }.toCompletable()

    /**
     * Clear pairing information
     */
    fun clearPairing(): Completable =
        dataStore.updateDataAsync { preferences ->
            preferences.mutations {
                it[isPairedKey] = false
                it[pcIpKey] = null
                it[pcPortKey] = null
                it[deviceIdKey] = null
                it[deviceSecretKey] = null
            }
        }.toCompletable()

    /**
     * Get device name
     */
    fun getDeviceName(): Single<String> =
        dataStore.data
            .map { it[deviceNameKey] ?: "Vanessa Phone" }
            .firstElement()

    /**
     * Set device name
     */
    fun setDeviceName(name: String): Completable =
        dataStore.updateDataAsync { preferences ->
            preferences.mutations {
                it[deviceNameKey] = name
            }
        }.toCompletable()
}