package com.vanessa.mobile.tools

import java.util.Calendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarSearchToolTest {
    @Test
    fun localDayStartsAtMidnight() {
        val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        val (start, end) = localDayWindow(1_700_000_000_000L, utc)
        assertTrue(1_700_000_000_000L in start until end)
        assertEquals(24 * 60 * 60 * 1000L, end - start)
    }

    @Test
    fun daylightSavingDayIsNotAssumedToBe24Hours() {
        val zone = TimeZone.getTimeZone("America/New_York")
        val day = Calendar.getInstance(zone).apply { set(2024, Calendar.MARCH, 10, 12, 0, 0) }
        val (start, end) = localDayWindow(day.timeInMillis, Calendar.getInstance(zone))
        assertEquals(23 * 60 * 60 * 1000L, end - start)
    }
}
