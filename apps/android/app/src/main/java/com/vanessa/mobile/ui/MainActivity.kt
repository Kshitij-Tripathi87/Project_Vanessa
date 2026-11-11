package com.vanessa.mobile.ui

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.viewModelScope
import com.vanessa.mobile.R
import com.vanessa.mobile.bridge.VanessaBridgeClient
import com.vanessa.mobile.di.PairingRepository
import com.vanessa.mobile.viewmodel.PairingViewModel
import dagger.hilt.android.AndroidEntryPoint
import io.reactivex.rxjava3.annotations.NonNull
import io.reactivex.rxjava3.core.CompletableObserver
import io.reactivex.rxjava3.core.Single
import io.reactivex.rxjava3.core.SingleObserver
import io.reactivex.rxjava3.disposables.Disposable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.observeAsState
import kotlinx.coroutines.launch

@AndroidEntryPoint
class MainActivity : AppCompatActivity() {

    private lateinit var viewModel: PairingViewModel
    private var qrScanJob: kotlinx.coroutines.Job? = null

    private val _bridgeState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val bridgeState: StateFlow<ConnectionState> = _bridgeState

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        viewModel = PairingViewModel(
            PairingRepository(),
            VanessaBridgeClient()
        )

        // Handle back press - if connected, disconnect instead
        val backPressedCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (_bridgeState.value is ConnectionState.Connected) {
                    viewModel.forgetDevice()
                } else {
                    cancel()
                }
            }
        }
        addOnBackPressedCallback(backPressedCallback)

        // Setup pairing observation
        setupPairingObservation()

        // Start with existing pairing check
        viewModel.checkExistingPairing()
    }

    private fun setupPairingObservation() {
        lifecycleScope.launch {
            viewModel.status.observeAsState(this@MainActivity).collect { status ->
                when (status) {
                    is PairingStatus.Pairing -> {
                        showPairingUI(status)
                    }
                    is PairingStatus.Success -> {
                        showConnectedUI(status)
                        // Auto-connect in background
                        bridgeClient.connect(
                            (status as PairingStatus.Success).deviceId,
                            /* we need the secret from repo */
                        )
                    }
                    is PairingStatus.Error -> {
                        showErrorUI(status)
                    }
                }
            }
        }

        viewModel.pairingCode.observeAsState(this@MainActivity).collect { code ->
            if (code != null) {
                showPairingCode(code)
            }
        }
    }

    private fun showPairingUI(status: PairingStatus.Pairing) {
        // Display QR code and pairing info
        Log.d("MainActivity", "Showing pairing UI for IP: ${status.pcIp}:${status.port}")
        // TODO: Update UI to show QR code
    }

    private fun showConnectedUI(status: PairingStatus.Success) {
        Log.d("MainActivity", "Connected successfully, device: ${status.deviceId}")
        // TODO: Update UI to show connected state
    }

    private fun showErrorUI(status: PairingStatus.Error) {
        Log.e("MainActivity", "Pairing error: ${status.message}")
        // TODO: Show error to user
    }

    private fun showPairingCode(code: String) {
        Log.d("MainActivity", "Pairing code: $code")
        // TODO: Show pairing code on screen
    }

    /**
     * Start QR code scanning
     */
    fun startQrScanner() {
        qrScanJob = kotlinx.coroutines.runBlocking {
            val intent = Intent(this, QrScannerActivity::class.java)
            startActivityForResult(intent, 1)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1 && resultCode == RESULT_OK && data != null) {
            val scannedCode = data.getStringExtra("scanned_code")
            if (scannedCode != null) {
                // Handle the scanned pairing code
                viewModel.completePairing(
                    deviceId = "device_${System.currentTimeMillis()}",
                    deviceSecret = scannedCode
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        qrScanJob?.cancel()
    }
}