package com.vanessa.mobile.viewmodel

import android.util.Base64
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.bridge.VanessaBridgeClient
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.bridge.ConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import dagger.hilt.android.lifecycle.HiltViewModel

/**
 * ViewModel for pairing flow
 */
@HiltViewModel
class PairingViewModel @Inject constructor(
    private val pairingRepository: PairingRepository,
    private val bridgeClient: VanessaBridgeClient
) : ViewModel() {

    // QR code data
    private val _qrCodeData = MutableStateFlow<String?>(null)
    val qrCodeData: StateFlow<String?> = _qrCodeData

    // Pairing code display
    private val _pairingCode = MutableStateFlow<String?>(null)
    val pairingCode: StateFlow<String?> = _pairingCode

    // PC info
    private val _pcIp = MutableStateFlow<String?>(null)
    val pcIp: StateFlow<String?> = _pcIp

    // Status
    private val _status = MutableStateFlow<PairingStatus>(PairingStatus.Idle)
    val status: StateFlow<PairingStatus> = _status

    sealed interface PairingStatus {
        data class Pairing(val pcIp: String, val port: Int, val pairingCode: String, val expiresAt: Long) : PairingStatus
        data class Success(val deviceId: String) : PairingStatus
        data class Error(val message: String) : PairingStatus
        object Idle : PairingStatus
    }

    /**
     * Start pairing with a PC
     */
    fun startPairing(pcIp: String, port: Int = 8765) {
        viewModelScope.launch {
            _status.value = PairingStatus.Pairing(pcIp, port, "", 0)
            _pcIp.value = pcIp

            // In a real implementation, we'd get this from the PC via a pairing endpoint
            // For now, we generate a mock pairing code
            val pairingCode = generatePairingCode()
            val expiresAt = System.currentTimeMillis() + 5 * 60 * 1000 // 5 minutes

            _pairingCode.value = pairingCode
            _status.value = PairingStatus.Pairing(pcIp, port, pairingCode, expiresAt)

            // Build QR code data
            val qrData = buildQrCodeData(pcIp, port, pairingCode)
            _qrCodeData.value = qrData
        }
    }

    /**
     * Complete pairing after user scans QR and confirms on PC
     */
    fun completePairing(deviceId: String, deviceSecret: String) {
        viewModelScope.launch {
            pairingRepository.savePairing(
                pcIp = _pcIp.value ?: "",
                pcPort = 8765,
                deviceId = deviceId,
                deviceSecret = deviceSecret
            ).subscribe(
                onSuccess = {
                    _status.value = PairingStatus.Success(deviceId)
                    // Connect to gateway
                    bridgeClient.connect(_pcIp.value!!, 8765, deviceSecret)
                },
                onError = { error ->
                    _status.value = PairingStatus.Error(error.message ?: "Pairing failed")
                }
            )
        }
    }

    /**
     * Forget paired device
     */
    fun forgetDevice() {
        viewModelScope.launch {
            pairingRepository.clearPairing().subscribe(
                onSuccess = { _status.value = PairingStatus.Idle },
                onError = { _status.value = PairingStatus.Error(it.message ?: "Failed to forget device") }
            )
            bridgeClient.disconnect()
        }
    }

    /**
     * Check existing pairing
     */
    fun checkExistingPairing() {
        viewModelScope.launch {
            pairingRepository.isPaired().subscribe(
                onSuccess = { isPaired ->
                    if (isPaired) {
                        pairingRepository.getPairedPcIp().subscribe(
                            onSuccess = { ip ->
                                if (ip != null) {
                                    pairingRepository.getPairedDeviceSecret().subscribe(
                                        onSuccess = { secret ->
                                            if (secret != null) {
                                                bridgeClient.connect(ip, 8765, secret)
                                            }
                                        }
                                    )
                                }
                            }
                        )
                    }
                }
            )
        }
    }

    private fun generatePairingCode(): String {
        // Generate a secure random pairing code
        val bytes = java.security.SecureRandom().run { nextBytes(ByteArray(16)); this }
        return bytes.let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP) }
    }

    private fun buildQrCodeData(pcIp: String, port: Int, pairingCode: String): String {
        return """
            {
                "type": "vanessa_pairing",
                "version": 1,
                "pcIp": "$pcIp",
                "port": $port,
                "pairingCode": "$pairingCode",
                "timestamp": ${System.currentTimeMillis()}
            }
        """.trimIndent()
    }
}