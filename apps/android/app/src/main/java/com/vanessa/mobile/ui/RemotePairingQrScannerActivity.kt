package com.vanessa.mobile.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
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
        window.statusBarColor = Color.rgb(3, 5, 10)
        window.navigationBarColor = Color.rgb(3, 5, 10)

        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(3, 5, 10))
        }
        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        container.addView(previewView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        container.addView(ScanFrameOverlay(this), FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val header = TextView(this).apply {
            text = "VANESSA  /  PC PAIRING"
            setTextColor(Color.rgb(53, 165, 255))
            textSize = 11f
            letterSpacing = 0.14f
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
            setPadding(dp(24), dp(22), dp(72), dp(12))
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = "Vanessa PC pairing scanner"
        }
        container.addView(header, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP,
        ))

        val close = TextView(this).apply {
            text = "×"
            textSize = 27f
            setTextColor(Color.rgb(242, 245, 248))
            gravity = Gravity.CENTER
            contentDescription = "Close scanner"
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.rgb(16, 23, 39))
                setStroke(dp(1), Color.rgb(37, 46, 59))
            }
            setOnClickListener {
                setResult(RESULT_CANCELED)
                finish()
            }
        }
        container.addView(close, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP or Gravity.END).apply {
            topMargin = dp(10)
            marginEnd = dp(16)
        })

        val instruction = TextView(this).apply {
            text = "Scan the one-time code shown on Windows.\nPairing data is read locally on this phone."
            setTextColor(Color.rgb(242, 245, 248))
            textSize = 13f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setBackgroundColor(0xE607090D.toInt())
            setPadding(dp(22), dp(18), dp(22), dp(22))
            gravity = Gravity.CENTER
            contentDescription = "Scan the one-time code shown on Windows"
        }
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

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    /**
     * Draws a quiet scanner target over the live camera preview. The frame is
     * decorative guidance only; ML Kit remains the authority for QR detection.
     */
    private class ScanFrameOverlay(context: Context) : View(context) {
        private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(90, 53, 165, 255)
            style = Paint.Style.STROKE
            strokeWidth = context.resources.displayMetrics.density
        }
        private val cobalt = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(53, 165, 255)
            style = Paint.Style.STROKE
            strokeWidth = 4f * context.resources.displayMetrics.density
            strokeCap = Paint.Cap.ROUND
        }
        private val lime = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(168, 244, 67)
            style = Paint.Style.STROKE
            strokeWidth = 4f * context.resources.displayMetrics.density
            strokeCap = Paint.Cap.ROUND
        }

        init {
            contentDescription = "QR scanning frame"
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val widthF = width.toFloat()
            val heightF = height.toFloat()
            val side = minOf(widthF * 0.72f, heightF * 0.34f)
            val left = (widthF - side) / 2f
            val top = heightF * 0.34f
            val rect = RectF(left, top, left + side, top + side)
            val radius = 22f * resources.displayMetrics.density
            canvas.drawRoundRect(rect, radius, radius, outline)

            val corner = side * 0.20f
            val inset = 2f * resources.displayMetrics.density
            // Cobalt on the upper-left and lower-left; lime on the right edge.
            canvas.drawLine(rect.left + inset, rect.top + corner, rect.left + inset, rect.top + radius, cobalt)
            canvas.drawLine(rect.left + radius, rect.top + inset, rect.left + corner, rect.top + inset, cobalt)
            canvas.drawLine(rect.left + inset, rect.bottom - corner, rect.left + inset, rect.bottom - radius, cobalt)
            canvas.drawLine(rect.left + radius, rect.bottom - inset, rect.left + corner, rect.bottom - inset, cobalt)
            canvas.drawLine(rect.right - inset, rect.top + corner, rect.right - inset, rect.top + radius, lime)
            canvas.drawLine(rect.right - radius, rect.top + inset, rect.right - corner, rect.top + inset, lime)
            canvas.drawLine(rect.right - inset, rect.bottom - corner, rect.right - inset, rect.bottom - radius, lime)
            canvas.drawLine(rect.right - radius, rect.bottom - inset, rect.right - corner, rect.bottom - inset, lime)
        }
    }

    companion object {
        const val EXTRA_QR_PAYLOAD = "vanessa.remote.qr.payload"
        const val EXTRA_ERROR = "vanessa.remote.qr.error"
        private const val REQUEST_CAMERA = 5204
    }
}
