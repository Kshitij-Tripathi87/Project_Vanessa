package com.vanessa.mobile.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.ConnectionState
import com.vanessa.mobile.bridge.VanessaBridgeClient
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.di.StoredPairing
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import org.json.JSONObject
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

    enum class Status { Idle, CodeScanned, Error }

    data class UiState(
        val status: Status = Status.Idle,
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
                    status = when {
                        pairing == null -> Status.Idle
                        pairing.expiresAt > System.currentTimeMillis() -> Status.CodeScanned
                        else -> Status.Idle
                    },
                )
            }
            .launchIn(viewModelScope)

        bridgeClient.connectionState
            .onEach { connection -> _state.value = _state.value.copy(connection = connection) }
            .launchIn(viewModelScope)
    }

    fun onPairingPayloadScanned(raw: String) {
        val parsed = runCatching { JSONObject(raw) }.getOrNull()
        if (parsed == null) {
            fail("That QR code is not a Vanessa pairing code.")
            return
        }
        val type = parsed.optString("type", "vanessa_pairing")
        val version = parsed.optInt("version", 1)
        val pcIp = parsed.optString("pcIP").ifBlank { parsed.optString("pcIp") }
        val port = parsed.optInt("port", 8765)
        val code = parsed.optString("pairingCode")
        val expiresAt = parsed.optLong("expiresAt", 0L)

        if (type != "vanessa_pairing" || version != 1) {
            fail("Unsupported pairing payload (type=$type version=$version).")
            return
        }
        if (pcIp.isBlank() || code.isBlank()) {
            fail("The pairing code is missing the PC address or code.")
            return
        }
        if (expiresAt in 1..System.currentTimeMillis()) {
            fail("That pairing code has expired. Show a fresh code on the PC.")
            return
        }

        viewModelScope.launch {
            pairingRepository.savePairing(
                StoredPairing(pcIp = pcIp, port = port, pairingCode = code, expiresAt = expiresAt)
            )
            _state.value = _state.value.copy(
                status = Status.CodeScanned,
                message = "Pairing code captured for $pcIp:$port. The PC still has to redeem it before the gateway accepts this phone.",
            )
        }
    }

    fun forgetDevice() {
        viewModelScope.launch {
            pairingRepository.clear()
            _state.value = _state.value.copy(status = Status.Idle, message = null)
        }
    }

    private fun fail(message: String) {
        _state.value = _state.value.copy(status = Status.Error, message = message)
    }
}
