package com.vanessa.mobile.agent

import ai.vanessa.agent.LocalToolExecutor
import ai.vanessa.agent.LocalToolResult
import com.vanessa.mobile.profile.AndroidDeviceProfiler
import com.vanessa.mobile.tools.CalendarSearchResult
import com.vanessa.mobile.tools.CalendarSearchTool
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** Read-only phone tools. Each adapter rechecks platform permissions at execution time. */
class AndroidLocalToolExecutor(
    private val profiler: AndroidDeviceProfiler,
    private val calendar: CalendarSearchTool,
) : LocalToolExecutor {
    override suspend fun execute(tool: String): LocalToolResult = withContext(Dispatchers.IO) {
        when (tool) {
            "android.device.status" -> {
                val p = profiler.snapshot()
                LocalToolResult.Success(
                    "Phone: ${p.manufacturer} ${p.model}; Android API ${p.apiLevel}; ABI ${p.abi}; " +
                        "RAM available ${p.ramAvailableMb} MB of ${p.ramTotalMb} MB; " +
                        "storage available ${p.storageAvailableMb} MB; " +
                        "battery ${p.batteryPercent?.let { "${it}%" } ?: "unknown"}; " +
                        "thermal status ${p.thermalStatus ?: "unknown"}; " +
                        "power saver ${if (p.powerSaveMode) "on" else "off"}."
                )
            }

            "android.calendar.search" -> when (val result = calendar.today()) {
                CalendarSearchResult.PermissionRequired -> LocalToolResult.PermissionRequired
                is CalendarSearchResult.Unavailable -> LocalToolResult.Unavailable(result.reason)
                is CalendarSearchResult.Success -> {
                    val events = result.meetings
                    val evidence = if (events.isEmpty()) {
                        "No events were found in the phone calendars today."
                    } else {
                        buildString {
                            append("Found ${events.size} event(s) in phone calendars today.")
                            events.take(6).forEach { event ->
                                append("\n- ")
                                append(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(event.startsAtMs)))
                                append(" ")
                                append(event.title.take(100))
                                append(" (")
                                append(event.calendarName.take(60))
                                append(")")
                            }
                            if (events.size > 6) append("\n- ${events.size - 6} additional event(s) omitted.")
                        }
                    }
                    LocalToolResult.Success(evidence.take(1000))
                }
            }

            else -> LocalToolResult.Unavailable("This phone tool is not registered.")
        }
    }
}
