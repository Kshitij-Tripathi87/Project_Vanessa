package com.vanessa.mobile.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.ConnectionState
import com.vanessa.mobile.bridge.VanessaBridgeClient
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.di.StoredPairing
import com.vanessa.mobile.pairing.PairingPayloadParser
import com.vanessa.mobile.pairing.PairingPayloadResult
import com.vanessa.mobile.pairing.PairingState
import com.vanessa.mobile.pairing.PairingStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the pairing screen.
 *
 * The QR payload carries a single-use pairing code, never the HMAC secret. The
 * secret is only issued when the PC redeems the code, and the gateway does not
 * expose that redemption yet, so a scanned code leaves the app waiting rather
 * than fabricating a connected session.
 */
@HiltViewModel
class PairingViewModel @Inject constructor(
    private val pairingRepository: PairingRepository,
    private val bridgeClient: VanessaBridgeClient,
) : ViewModel() {

    data class UiState(
        val status: PairingStatus = PairingStatus.Idle,
        val pairing: StoredPairing? = null,
        val connection: ConnectionState = ConnectionState.Disconnected,
        val message: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        pairingRepository.pairing
            .onEach { pairing ->
                _state.value = _state.value.copy(
                    pairing = pairing,
                    status = PairingState.statusFor(pairing, System.currentTimeMillis()),
                )
            }
            .launchIn(viewModelScope)

        bridgeClient.connectionState
            .onEach { connection -> _state.value = _state.value.copy(connection = connection) }
            .launchIn(viewModelScope)
    }

    fun onPairingPayloadScanned(raw: String) {
        when (val result = PairingPayloadParser.parse(raw)) {
            is PairingPayloadResult.Invalid ->
                _state.value = _state.value.copy(status = PairingStatus.Error, message = result.reason)

            is PairingPayloadResult.Valid -> viewModelScope.launch {
                pairingRepository.savePairing(result.pairing)
                _state.value = _state.value.copy(
                    status = PairingStatus.CodeScanned,
                    message = "Pairing code captured for ${result.pairing.pcIp}:${result.pairing.port}. " +
                        "The PC still has to redeem it before the gateway accepts this phone.",
                )
            }
        }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            pairingRepository.clear()
            _state.value = _state.value.copy(status = PairingStatus.Idle, message = null)
        }
    }
}
