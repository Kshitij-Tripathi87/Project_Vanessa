package com.vanessa.mobile.profile

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProfileTest {
    @Test
    fun unverifiedRuntimeNeverEnablesLocalInference() {
        assertEquals(OperatingMode.COMPATIBILITY, OperatingMode.select("arm64-v8a", 8192, false, true, false))
        assertEquals(OperatingMode.COMPATIBILITY, OperatingMode.select("arm64-v8a", 8192, false, false, true))
    }

    @Test
    fun unsupportedAbiAndMemoryPressureStayInCompatibilityMode() {
        assertEquals(OperatingMode.COMPATIBILITY, OperatingMode.select("armeabi-v7a", 8192, false, true, true))
        assertEquals(OperatingMode.COMPATIBILITY, OperatingMode.select("arm64-v8a", 512, false, true, true))
        assertEquals(OperatingMode.COMPATIBILITY, OperatingMode.select("arm64-v8a", 8192, true, true, true))
    }

    @Test
    fun supportedAndVerifiedRuntimeCanEnterLocalMode() {
        assertEquals(OperatingMode.LOCAL_AGENT, OperatingMode.select("arm64-v8a", 2048, false, true, true))
    }
}
