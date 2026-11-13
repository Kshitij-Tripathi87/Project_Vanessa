package com.vanessa.mobile.profile

import android.Manifest
import android.app.ActivityManager
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs

/** A point-in-time observation, not a grant to read personal data or run inference. */
data class DeviceProfile(
    val profileVersion: Int = 1,
    val measuredAtMs: Long,
    val apiLevel: Int,
    val manufacturer: String,
    val model: String,
    val abi: String,
    val ramTotalMb: Long,
    val ramAvailableMb: Long,
    val storageAvailableMb: Long,
    val lowMemory: Boolean,
    val batteryPercent: Int?,
    val charging: Boolean?,
    val thermalStatus: Int?,
    val powerSaveMode: Boolean,
    val calendarReadGranted: Boolean,
    val inferenceRuntimeInstalled: Boolean = false,
    val modelLoadVerified: Boolean = false,
) {
    val operatingMode: OperatingMode
        get() = OperatingMode.select(abi, ramAvailableMb, lowMemory, inferenceRuntimeInstalled, modelLoadVerified)
}

enum class OperatingMode {
    COMPATIBILITY,
    LOCAL_AGENT;

    companion object {
        fun select(
            abi: String,
            availableRamMb: Long,
            lowMemory: Boolean,
            runtimeInstalled: Boolean,
            modelLoadVerified: Boolean,
        ): OperatingMode = if (
            abi == "arm64-v8a" && !lowMemory && availableRamMb >= 1024 &&
            runtimeInstalled && modelLoadVerified
        ) LOCAL_AGENT else COMPATIBILITY
    }
}

/** Reads only public device resource signals; missing OS data stays unknown. */
class AndroidDeviceProfiler(private val context: Context) {
    fun snapshot(): DeviceProfile {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memory)
        val storage = StatFs(context.filesDir.path)
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val batteryPercent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else null
        val charging = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
            else -> null
        }
        return DeviceProfile(
            measuredAtMs = System.currentTimeMillis(),
            apiLevel = Build.VERSION.SDK_INT,
            manufacturer = Build.MANUFACTURER ?: "Unknown",
            model = Build.MODEL ?: "Unknown",
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            ramTotalMb = memory.totalMem / MIB,
            ramAvailableMb = memory.availMem / MIB,
            storageAvailableMb = storage.availableBytes / MIB,
            lowMemory = memory.lowMemory,
            batteryPercent = batteryPercent,
            charging = charging,
            thermalStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power.currentThermalStatus else null,
            powerSaveMode = power.isPowerSaveMode,
            calendarReadGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
                    PackageManager.PERMISSION_GRANTED,
        )
    }

    private companion object {
        const val MIB = 1024L * 1024L
    }
}
