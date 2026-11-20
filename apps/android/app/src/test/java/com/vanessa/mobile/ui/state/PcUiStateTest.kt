package com.vanessa.mobile.ui.state

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The dashboard's job is to be right about three separate facts: what is
 * stored, what the socket is doing, and what the PC says it can do.
 */
class PcUiStateTest {

    private val identity = PcIdentity(
        name = "Desktop",
        endpoint = "100.101.102.103:8443",
        fingerprint = "9f2c4a71b0d84c6b5e3f1a2c7d8e9f10",
    )

    private fun manifest(vararg capabilities: JsonObject): JsonObject = buildJsonObject {
        put("manifestVersion", "1")
        put("generatedAt", 1_700_000_000_000L)
        put("policyVersion", "3")
        put("capabilities", JsonArray(capabilities.toList()))
    }

    private fun capability(name: String, description: String = "", tier: String = "safe"): JsonObject =
        buildJsonObject {
            put("name", name)
            put("description", description)
            put("tier", tier)
            put("scopes", JsonArray(emptyList()))
            put("idempotent", true)
            put("timeoutMs", 5000)
            put("argumentsSchema", buildJsonObject { })
        }

    @Test
    fun anUnpairedPhoneIsUnpaired() {
        val state = PcUiState()
        assertFalse(state.paired)
        assertEquals(PcLink.UNPAIRED, state.link)
    }

    @Test
    fun connectingAndReconnectingAreDifferentStates() {
        val connecting = reducePcConnection(PcUiState(identity = identity), "Connecting to Desktop…")
        assertEquals(PcLink.CONNECTING, connecting.link)

        val reconnecting = reducePcConnection(PcUiState(identity = identity), "Reconnecting to Desktop…")
        assertEquals(PcLink.RECONNECTING, reconnecting.link)
    }

    @Test
    fun aConnectedSessionKeepsTheStoredIdentity() {
        val state = reducePcConnection(PcUiState(identity = identity), "Connected securely to Desktop.")
        assertEquals(PcLink.CONNECTED, state.link)
        assertEquals(identity, state.identity)
    }

    @Test
    fun aDisconnectIsReportedAsDisconnectedNotAsUnpaired() {
        val connected = reducePcConnection(PcUiState(identity = identity), "Connected securely to Desktop.")
        val dropped = reducePcConnection(connected, "Remote PC disconnected: socket closed")
        assertEquals(PcLink.DISCONNECTED, dropped.link)
        assertTrue("A dropped socket does not unpair the phone", dropped.paired)
    }

    @Test
    fun aBadQrIsAnErrorRatherThanAQuietNoOp() {
        val state = reducePcConnection(PcUiState(), "Invalid PC pairing QR: malformed payload")
        assertEquals(PcLink.ERROR, state.link)
    }

    @Test
    fun anUnrecognisedLineLeavesTheLinkAlone() {
        val connected = reducePcConnection(PcUiState(identity = identity), "Connected securely to Desktop.")
        val after = reducePcConnection(connected, "Something else entirely")
        assertEquals(PcLink.CONNECTED, after.link)
        assertEquals("Something else entirely", after.detail)
    }

    @Test
    fun capabilitiesAreEmptyUntilAManifestArrives() {
        val connected = reducePcConnection(PcUiState(identity = identity), "Connected securely to Desktop.")
        assertFalse(connected.manifestReceived)
        assertTrue(connected.capabilities.isEmpty())
        assertNull(connected.capability("open_app"))
    }

    @Test
    fun aManifestSuppliesTheCapabilitiesAndNothingElseDoes() {
        val connected = reducePcConnection(PcUiState(identity = identity), "Connected securely to Desktop.")
        val withManifest = applyManifest(
            connected,
            manifest(capability("open_app", "Opens an app"), capability("system_status", "Reads the PC")),
        )
        assertTrue(withManifest.manifestReceived)
        assertEquals(listOf("open_app", "system_status"), withManifest.capabilities.map { it.name })
        assertEquals("Opens an app", withManifest.capability("open_app")?.description)
    }

    @Test
    fun malformedCapabilitiesAreDroppedRatherThanRenderedBlank() {
        val withManifest = applyManifest(
            PcUiState(identity = identity),
            manifest(
                capability("open_app"),
                buildJsonObject { put("description", "no name") },
            ),
        )
        assertEquals(listOf("open_app"), withManifest.capabilities.map { it.name })
    }

    @Test
    fun duplicateCapabilitiesCollapse() {
        val withManifest = applyManifest(
            PcUiState(identity = identity),
            manifest(capability("open_app", "first"), capability("open_app", "second")),
        )
        assertEquals(1, withManifest.capabilities.size)
        assertEquals("first", withManifest.capabilities.first().description)
    }

    @Test
    fun capabilitiesAreDroppedWhenTheSessionEnds() {
        val withManifest = applyManifest(
            PcUiState(identity = identity),
            manifest(capability("open_app")),
        )
        val dropped = reducePcConnection(withManifest, "Remote PC disconnected: socket closed")
        assertTrue("A capability list belongs to a session, not a device", dropped.capabilities.isEmpty())
        assertFalse(dropped.manifestReceived)
    }

    @Test
    fun reconnectIsOfferedOnlyWhenThereIsSomethingToReconnectTo() {
        assertFalse(PcUiState().canReconnect)
        assertTrue(PcUiState(identity = identity).canReconnect)
        val connecting = reducePcConnection(PcUiState(identity = identity), "Connecting to Desktop…")
        assertFalse("No double-connect while a connect is in flight", connecting.canReconnect)
    }

    @Test
    fun theConnectedLineYieldsThePcName() {
        assertEquals("Desktop", PcUiState.nameFromConnected("Connected securely to Desktop."))
        assertNull(PcUiState.nameFromConnected("Connecting to Desktop…"))
    }

    @Test
    fun aShortFingerprintIsShownInFull() {
        assertEquals("abc", PcIdentity("pc", "host", "abc").shortFingerprint)
        assertEquals("1234567890123456…", PcIdentity("pc", "host", "12345678901234567890").shortFingerprint)
    }
}
