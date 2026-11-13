package com.vanessa.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.vanessa.mobile.R
import com.vanessa.mobile.profile.AndroidDeviceProfiler
import com.vanessa.mobile.profile.DeviceProfile
import com.vanessa.mobile.profile.OperatingMode
import com.vanessa.mobile.tools.CalendarMeeting
import com.vanessa.mobile.tools.CalendarSearchResult
import com.vanessa.mobile.tools.CalendarSearchTool
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat

/** Offline foundation. The legacy HMAC pairing client is deliberately not reachable from this UI. */
class MainActivity : ComponentActivity() {
    private var profile by mutableStateOf<DeviceProfile?>(null)
    private val profiler by lazy { AndroidDeviceProfiler(this) }
    private val calendarTool by lazy { CalendarSearchTool(this) }
    private var meetings by mutableStateOf<List<CalendarMeeting>>(emptyList())
    private var calendarMessage by mutableStateOf<String?>(null)
    private var calendarJob: Job? = null
    private val requestCalendar = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refreshProfile()
        if (granted) searchCalendar() else {
            meetings = emptyList()
            calendarMessage = "Calendar permission denied. No events were read."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
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
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    DeviceScreen(
                        profile, meetings, calendarMessage, onRefresh = ::refreshProfile,
                        onReadCalendar = ::requestMeetings
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshProfile()
    }

    private fun refreshProfile() {
        profile = profiler.snapshot()
        if (!hasCalendarPermission()) {
            calendarJob?.cancel()
            meetings = emptyList()
            calendarMessage = null
        }
    }

    private fun hasCalendarPermission(): Boolean = ContextCompat.checkSelfPermission(
        this, Manifest.permission.READ_CALENDAR
    ) == PackageManager.PERMISSION_GRANTED

    private fun requestMeetings() {
        if (hasCalendarPermission()) searchCalendar()
        else requestCalendar.launch(Manifest.permission.READ_CALENDAR)
    }

    private fun searchCalendar() {
        calendarJob?.cancel()
        meetings = emptyList()
        calendarMessage = "Searching phone calendar…"
        calendarJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { calendarTool.today() }
            if (!hasCalendarPermission()) {
                meetings = emptyList()
                calendarMessage = "Calendar permission was removed. No events are shown."
            } else when (result) {
                is CalendarSearchResult.Success -> {
                    meetings = result.meetings
                    calendarMessage = if (meetings.isEmpty()) "No events in the phone calendars today." else
                        "${meetings.size} event(s) from phone calendars today."
                }

                CalendarSearchResult.PermissionRequired -> calendarMessage = "Calendar permission required."
                is CalendarSearchResult.Unavailable -> calendarMessage = result.reason
            }
        }
    }
}

@Composable
private fun DeviceScreen(
    profile: DeviceProfile?,
    meetings: List<CalendarMeeting>,
    calendarMessage: String?,
    onRefresh: () -> Unit,
    onReadCalendar: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Vanessa", style = MaterialTheme.typography.headlineMedium)
        Text("Local device diagnostics", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "This build runs locally. Secure PC pairing, on-device Qwen and voice are not available yet; " +
                    "the legacy unencrypted pairing client is disabled.",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (profile == null) {
            Text("Reading device status…")
        } else {
            Text(
                "Mode: ${if (profile.operatingMode == OperatingMode.COMPATIBILITY) "Compatibility" else "Local agent"}",
                style = MaterialTheme.typography.titleMedium,
            )
            Text("Device: ${profile.manufacturer} ${profile.model} · Android API ${profile.apiLevel}")
            Text("CPU ABI: ${profile.abi}")
            Text("RAM: ${profile.ramAvailableMb} MB available / ${profile.ramTotalMb} MB total")
            Text("App storage available: ${profile.storageAvailableMb} MB")
            Text("Memory pressure: ${if (profile.lowMemory) "Low memory" else "Normal"}")
            Text("Battery: ${profile.batteryPercent?.let { "$it%" } ?: "Unknown"} · ${
                when (profile.charging) {
                    true -> "Charging"
                    false -> "Not charging"
                    null -> "Charging state unknown"
                }
            }")
            Text("Power saver: ${if (profile.powerSaveMode) "On" else "Off"}")
            Text("Thermal status: ${profile.thermalStatus?.toString() ?: "Unavailable on this Android version"}")
            Text("Calendar permission: ${if (profile.calendarReadGranted) "Granted" else "Not granted"}")
            Text("Local model: Not installed or verified")
            Text("PC connection: Unavailable (secure v2 pairing not implemented)")
            Text(
                "Profile version ${profile.profileVersion} · updated ${java.util.Date(profile.measuredAtMs)}",
                style = MaterialTheme.typography.bodySmall
            )
        }
        Button(onClick = onRefresh) { Text("Refresh device status") }
        Text("Phone calendar", style = MaterialTheme.typography.titleMedium)
        Text("Events stay on this device. Android will ask for calendar access when needed.")
        Button(onClick = onReadCalendar) { Text("Check today's meetings") }
        calendarMessage?.let { Text(it) }
        meetings.forEach { event ->
            Text(
                "${DateFormat.getTimeInstance(DateFormat.SHORT).format(java.util.Date(event.startsAtMs))} · " +
                        "${event.title} · Phone calendar: ${event.calendarName}"
            )
        }
    }
}
