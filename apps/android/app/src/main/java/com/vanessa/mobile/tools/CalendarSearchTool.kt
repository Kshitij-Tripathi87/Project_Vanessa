package com.vanessa.mobile.tools

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import androidx.core.content.ContextCompat
import java.util.Calendar

/** Read-only, phone-owned calendar tool. No results are persisted or sent to a PC. */
data class CalendarMeeting(val title: String, val calendarName: String, val startsAtMs: Long, val endsAtMs: Long)

sealed interface CalendarSearchResult {
    data class Success(val meetings: List<CalendarMeeting>) : CalendarSearchResult
    data object PermissionRequired : CalendarSearchResult
    data class Unavailable(val reason: String) : CalendarSearchResult
}

/** Local-day bounds in the device's current timezone, including 23/25-hour daylight-saving days. */
fun localDayWindow(nowMs: Long, calendar: Calendar = Calendar.getInstance()): Pair<Long, Long> {
    calendar.timeInMillis = nowMs
    calendar.set(Calendar.HOUR_OF_DAY, 0)
    calendar.set(Calendar.MINUTE, 0)
    calendar.set(Calendar.SECOND, 0)
    calendar.set(Calendar.MILLISECOND, 0)
    val start = calendar.timeInMillis
    calendar.add(Calendar.DAY_OF_MONTH, 1)
    return start to calendar.timeInMillis
}

class CalendarSearchTool(private val context: Context) {
    fun today(): CalendarSearchResult {
        if (ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.READ_CALENDAR
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return CalendarSearchResult.PermissionRequired
        }
        val (start, end) = localDayWindow(System.currentTimeMillis())
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, start)
            ContentUris.appendId(it, end)
        }.build()
        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
        )
        return try {
            val cursor =
                context.contentResolver.query(uri, projection, null, null, "${CalendarContract.Instances.BEGIN} ASC")
                    ?: return CalendarSearchResult.Unavailable("The calendar provider did not return a result.")
            cursor.use {
                val title = it.getColumnIndexOrThrow(CalendarContract.Instances.TITLE)
                val name = it.getColumnIndexOrThrow(CalendarContract.Instances.CALENDAR_DISPLAY_NAME)
                val begin = it.getColumnIndexOrThrow(CalendarContract.Instances.BEGIN)
                val finish = it.getColumnIndexOrThrow(CalendarContract.Instances.END)
                val meetings = mutableListOf<CalendarMeeting>()
                while (it.moveToNext()) {
                    meetings.add(
                        CalendarMeeting(
                            title = it.getString(title) ?: "Untitled event",
                            calendarName = it.getString(name) ?: "Unknown calendar",
                            startsAtMs = it.getLong(begin),
                            endsAtMs = it.getLong(finish),
                        )
                    )
                }
                CalendarSearchResult.Success(meetings)
            }
        } catch (_: SecurityException) {
            CalendarSearchResult.PermissionRequired
        } catch (_: RuntimeException) {
            CalendarSearchResult.Unavailable("Unable to read the phone calendar right now.")
        }
    }
}
