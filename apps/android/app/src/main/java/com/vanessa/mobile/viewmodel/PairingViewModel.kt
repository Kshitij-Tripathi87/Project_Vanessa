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
 * phone redeems the code at the PC's `POST /pair` route, stores the device id
 * and secret it receives, and connects with that device id so the gateway can
 * verify this phone's signatures.
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
                val scanned = result.pairing
                pairingRepository.savePairing(scanned)
                _state.value = _state.value.copy(
                    status = PairingStatus.CodeScanned,
                    message = "Redeeming pairing code with ${scanned.pcIp}:${scanned.port}…",
                )

                val grant = bridgeClient.redeemPairing(
                    pcIp = scanned.pcIp,
                    port = scanned.port,
                    pairingCode = scanned.pairingCode,
                    deviceName = android.os.Build.MODEL,
                )

                if (grant == null) {
                    _state.value = _state.value.copy(
                        status = PairingStatus.Error,
                        message = "The PC rejected this pairing code. It may have expired or " +
                            "already been used — generate a new code on the PC and scan again.",
                    )
                    return@launch
                }

                val paired = scanned.copy(deviceId = grant.deviceId, secret = grant.secret)
                pairingRepository.savePairing(paired)
                _state.value = _state.value.copy(
                    status = PairingStatus.Paired,
                    message = "Paired with ${grant.pcName ?: scanned.pcIp}.",
                )

                bridgeClient.connect(
                    pcIP = paired.pcIp,
                    port = paired.port,
                    deviceId = grant.deviceId,
                    secret = grant.secret,
                )
            }
        }
    }

    /** Reconnect using the stored pairing, if this phone is already paired. */
    fun connect() {
        val pairing = _state.value.pairing ?: return
        val deviceId = pairing.deviceId ?: return
        val secret = pairing.secret ?: return

        viewModelScope.launch {
            bridgeClient.connect(pairing.pcIp, pairing.port, deviceId, secret)
        }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            bridgeClient.disconnect()
            pairingRepository.clear()
            _state.value = _state.value.copy(status = PairingStatus.Idle, message = null)
        }
    }
}
