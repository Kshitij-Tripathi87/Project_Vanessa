package com.vanessa.mobile.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.BridgeEvent
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

/** Drives the mobile pairing and remote connection lifecycle. */
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

    private val stateFlow = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = stateFlow.asStateFlow()
    private var pendingPairing: StoredPairing? = null
    private var restoredConnectionAttempted = false

    init {
        pairingRepository.pairing
            .onEach { pairing ->
                stateFlow.value = stateFlow.value.copy(
                    pairing = pairing,
                    status = PairingState.statusFor(pairing, System.currentTimeMillis()),
                )
                if (!restoredConnectionAttempted && !pairing?.deviceId.isNullOrBlank()) {
                    restoredConnectionAttempted = true
                    viewModelScope.launch { bridgeClient.connect(pairing!!) }
                }
            }
            .launchIn(viewModelScope)

        bridgeClient.connectionState
            .onEach { connection -> stateFlow.value = stateFlow.value.copy(connection = connection) }
            .launchIn(viewModelScope)

        bridgeClient.events
            .onEach { event ->
                when (event) {
                    is BridgeEvent.PairingPending -> {
                        stateFlow.value = stateFlow.value.copy(
                            status = PairingStatus.AwaitingApproval,
                            message = "Phone identity verified. Approve this device on the PC to finish pairing.",
                        )
                    }
                    is BridgeEvent.SessionReady -> {
                        val source = pendingPairing ?: stateFlow.value.pairing
                        if (source != null) {
                            val trusted = source.copy(
                                deviceId = event.deviceId,
                                pairingId = "",
                                pairingCode = "",
                            )
                            pendingPairing = null
                            pairingRepository.savePairing(trusted)
                            stateFlow.value = stateFlow.value.copy(
                                pairing = trusted,
                                status = PairingStatus.Paired,
                                message = "Secure connection established with the paired PC.",
                            )
                        }
                    }
                    else -> Unit
                }
            }
            .launchIn(viewModelScope)
    }

    fun onPairingPayloadScanned(raw: String) {
        when (val result = PairingPayloadParser.parse(raw)) {
            is PairingPayloadResult.Invalid -> {
                stateFlow.value = stateFlow.value.copy(status = PairingStatus.Error, message = result.reason)
            }
            is PairingPayloadResult.Valid -> {
                val scanned = result.pairing
                pendingPairing = scanned
                stateFlow.value = stateFlow.value.copy(
                    pairing = scanned,
                    status = PairingStatus.CodeScanned,
                    message = "Connecting to " + scanned.endpoint + " and proving this phone's identity…",
                )
                viewModelScope.launch { bridgeClient.connect(scanned) }
            }
        }
    }

    /** Reconnect using the pinned PC identity and Android Keystore device key. */
    fun connect() {
        val pairing = stateFlow.value.pairing ?: return
        if (pairing.deviceId.isNullOrBlank()) return
        viewModelScope.launch { bridgeClient.connect(pairing) }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            bridgeClient.disconnect()
            pendingPairing = null
            pairingRepository.clear()
            stateFlow.value = stateFlow.value.copy(
                pairing = null,
                status = PairingStatus.Idle,
                message = "This phone's local PC pairing has been forgotten.",
            )
        }
    }
}
