package com.vanessa.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.mlkit.barcode.scanning.BarcodeScanner
import com.google.mlkit.barcode.scanning.BarcodeScanning
import com.google.mlkit.barcode.scanning.common.InputImage
import com.google.mlkit.barcode.scanning.common.result.Barcode
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class QrScannerActivity : AppCompatActivity() {

    private lateinit var scanner: BarcodeScanner
    private var scanning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request camera permission if not granted
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                arrayOf(Manifest.permission.CAMERA),
                1
            )
        }

        scanner = BarcodeScanning.getClient()
        startScanning()
    }

    private fun startScanning() {
        if (!scanning) {
            scanning = true
            launch {
                while (isActive && scanning) {
                    // Simulate capture frame processing
                    // In real implementation, receive camera frames and process
                    delay(100)
                }
            }
        }
    }

    /**
     * Process a bitmap/ image to find QR codes
     */
    private fun processImage(image: Any) {
        // Convert to InputImage and scan
        val inputImage = InputImage.fromBitmap(image as android.graphics.Bitmap, 0)
        scanner.process(inputImage) { barcodes ->
            if (barcodes.isNotEmpty()) {
                val barcode = barcodes[0]
                val rawBytes = barcode.rawBytes
                val displayValue = barcode.displayValue

                // Return the scanned code via result
                val intent = Intent()
                intent.putExtra("scanned_code", displayValue)
                setResult(RESULT_OK, intent)
                finish()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        scanning = false
    }
}