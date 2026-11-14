package com.vanessa.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * Camera-backed QR scanner.
 *
 * The PC shows a one-time v2 QR payload containing its Tailscale TLS endpoint,
 * a short-lived pairing claim and its pinned ES256 public identity. It contains
 * no reusable shared secret or private key.
 */
class QrScannerActivity : ComponentActivity() {

    companion object {
        const val EXTRA_SCANNED_PAYLOAD = "scanned_payload"
    }

    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
    )
    private val delivered = java.util.concurrent.atomic.AtomicBoolean(false)

    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            setContent { ScannerScreen(onPreviewReady = ::bindCamera) }
        } else {
            Toast.makeText(this, "Camera permission is required to scan the pairing code.", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            setContent { ScannerScreen(onPreviewReady = ::bindCamera) }
        } else {
            requestCamera.launch(Manifest.permission.CAMERA)
        }
    }

    @Composable
    private fun ScannerScreen(onPreviewReady: (PreviewView) -> Unit) {
        val context = LocalContext.current
        val previewView = remember {
            PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
        }
        DisposableEffect(previewView) {
            onPreviewReady(previewView)
            onDispose { }
        }
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
            Text(
                text = "Point the camera at the QR code on the Vanessa PC window",
                modifier = Modifier.align(Alignment.BottomCenter),
                color = androidx.compose.ui.graphics.Color.White
            )
        }
    }

    private fun bindCamera(previewView: PreviewView) {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(cameraExecutor, ::analyze) }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    @OptIn(ExperimentalGetImage::class)
    private fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                val value = barcodes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
                if (value != null && delivered.compareAndSet(false, true))
                    setResult(RESULT_OK, android.content.Intent().putExtra(EXTRA_SCANNED_PAYLOAD, value))
                    finish()
                }
            }
            .addOnCompleteListener { imageProxy.close() }
    }

    override fun onDestroy() {
        super.onDestroy()
        scanner.close()
        cameraExecutor.shutdown()
    }
}
