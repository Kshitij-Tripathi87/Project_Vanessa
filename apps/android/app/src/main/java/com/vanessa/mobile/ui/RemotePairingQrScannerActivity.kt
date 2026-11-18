package com.vanessa.mobile.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** CameraX + ML Kit QR scanner. Only QR_CODE is decoded; nothing is uploaded. */
class RemotePairingQrScannerActivity : ComponentActivity() {
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val completed = AtomicBoolean(false)
    private lateinit var previewView: PreviewView
    private lateinit var scanner: BarcodeScanner

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = FrameLayout(this)
        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        val instruction = TextView(this).apply {
            text = "Align the Vanessa pairing QR code inside the camera view"
            setTextColor(android.graphics.Color.WHITE)
            setBackgroundColor(0x99000000.toInt())
            setPadding(24, 20, 24, 20)
            gravity = Gravity.CENTER
        }
        container.addView(previewView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        container.addView(instruction, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))
        setContentView(container)

        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        scanner = BarcodeScanning.getClient(options)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            if (isFinishing || isDestroyed) return@addListener
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(cameraExecutor) { proxy ->
                val mediaImage = proxy.image
                if (mediaImage == null || completed.get()) {
                    proxy.close()
                } else {
                    val image = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
                    scanner.process(image)
                        .addOnSuccessListener { barcodes ->
                            val value = barcodes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }
                                ?.rawValue
                            if (!value.isNullOrBlank() && completed.compareAndSet(false, true)) {
                                runOnUiThread {
                                    setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_PAYLOAD, value))
                                    finish()
                                }
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
            }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (error: Exception) {
                setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, error.message ?: "Camera unavailable"))
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
            else {
                setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, "Camera permission was denied. You can paste the QR payload instead."))
                finish()
            }
        }
    }

    override fun onDestroy() {
        runCatching { scanner.close() }
        cameraExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_QR_PAYLOAD = "vanessa.remote.qr.payload"
        const val EXTRA_ERROR = "vanessa.remote.qr.error"
        private const val REQUEST_CAMERA = 5204
    }
}
