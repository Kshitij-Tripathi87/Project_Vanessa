package com.vanessa.mobile.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.vanessa.mobile.R
import com.vanessa.mobile.bridge.ConnectionState
import com.vanessa.mobile.pairing.PairingStatus
import com.vanessa.mobile.viewmodel.PairingViewModel
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    private val viewModel: PairingViewModel by viewModels()

    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val payload = result.data?.getStringExtra(QrScannerActivity.EXTRA_SCANNED_PAYLOAD)
        if (result.resultCode == RESULT_OK && payload != null) {
            viewModel.onPairingPayloadScanned(payload)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val state by viewModel.state.collectAsState()
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = colorResource(R.color.vanessa_primary),
                    secondary = colorResource(R.color.vanessa_secondary),
                    background = colorResource(R.color.vanessa_background),
                    surface = colorResource(R.color.vanessa_surface),
                    onPrimary = colorResource(R.color.vanessa_on_primary),
                    onSurface = colorResource(R.color.vanessa_on_surface),
                    error = colorResource(R.color.vanessa_error),
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    PairingScreen(
                        state = state,
                        onScanQr = {
                            scanLauncher.launch(Intent(this@MainActivity, QrScannerActivity::class.java))
                        },
                        onForgetDevice = { viewModel.forgetDevice() },
                    )
                }
            }
        }
    }
}

@Composable
private fun PairingScreen(
    state: PairingViewModel.UiState,
    onScanQr: () -> Unit,
    onForgetDevice: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = stringResourceText(R.string.pairing_title),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurface
        )
        Text(
            text = stringResourceText(R.string.pairing_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface
        )

        Text(
            text = when (state.status) {
                PairingStatus.Idle -> "Not paired"
                PairingStatus.CodeScanned -> "Pairing code captured"
                PairingStatus.Error -> "Error"
            },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = when (state.status) {
                PairingStatus.Error -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.onSurface
            }
        )

        state.pairing?.let { pairing ->
            Text("PC: ${pairing.pcIp}:${pairing.port}", color = MaterialTheme.colorScheme.onSurface)
            Text(
                text = "Code valid until ${java.util.Date(pairing.expiresAt)}",
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodySmall
            )
        }

        Text(
            text = when (val connection = state.connection) {
                is ConnectionState.Connected -> "Gateway connected to ${connection.pcIP}"
                ConnectionState.Connecting -> "Connecting to gateway…"
                ConnectionState.Disconnected -> "Gateway disconnected"
                is ConnectionState.Error -> "Gateway error: ${connection.message}"
            },
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodySmall
        )

        state.message?.let { message ->
            Text(text = message, color = MaterialTheme.colorScheme.secondary)
        }

        Button(onClick = onScanQr, modifier = Modifier.padding(top = 8.dp)) {
            Text("Scan PC pairing code")
        }

        if (state.pairing != null) {
            OutlinedButton(onClick = onForgetDevice) {
                Text(stringResourceText(R.string.forget_device))
            }
        }

        Text(
            text = stringResourceText(R.string.tools_empty),
            color = Color.Gray,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 16.dp)
        )
    }
}

@Composable
private fun stringResourceText(id: Int): String = androidx.compose.ui.res.stringResource(id)
