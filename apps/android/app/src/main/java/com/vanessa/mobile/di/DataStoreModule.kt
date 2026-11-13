package com.vanessa.mobile.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

private val Context.vanessaPreferences: DataStore<Preferences> by preferencesDataStore(name = "vanessa_preferences")

/**
 * Provides the single Preferences DataStore used for pairing state.
 *
 * The pair secret is deliberately not stored here: the QR payload carries a
 * single-use pairing code and the secret is issued by the PC on redemption.
 */
@Module
@InstallIn(SingletonComponent::class)
object DataStoreModule {

    @Provides
    @Singleton
    fun provideDataStore(@ApplicationContext context: Context): DataStore<Preferences> =
        context.vanessaPreferences
}
